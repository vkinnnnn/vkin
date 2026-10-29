#include "engine.h"

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <dmo.h>
#include <mediaobj.h>
#include <uuids.h>
#include <propsys.h>
#include <wmcodecdsp.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>

#ifndef WMAAECMA_E_NO_ACTIVE_RENDER_STREAM
#define WMAAECMA_E_NO_ACTIVE_RENDER_STREAM ((HRESULT)0x87CC000AL)
#endif

using Microsoft::WRL::ComPtr;

namespace fabel {
namespace {

constexpr int kRate = 16000;
constexpr REFERENCE_TIME kBufferHns = 2000000;  // 200 ms shared-mode buffer

const char* kNames[kChannelCount] = {"them", "me", "meRaw"};

std::string Hr(const char* what, HRESULT hr) {
  char buf[160];
  std::snprintf(buf, sizeof(buf), "%s failed (0x%08lX)", what, static_cast<unsigned long>(hr));
  return buf;
}

std::string Utf8(const wchar_t* w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return "";
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

double QpcFreq() {
  static const double f = [] {
    LARGE_INTEGER x;
    QueryPerformanceFrequency(&x);
    return static_cast<double>(x.QuadPart);
  }();
  return f;
}

// COM apartment per worker thread (MTA). Never touches the Electron main thread's STA.
struct ComScope {
  HRESULT hr;
  ComScope() { hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
  ~ComScope() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

struct MmcssScope {
  HANDLE h = nullptr;
  MmcssScope() {
    DWORD idx = 0;
    h = AvSetMmThreadCharacteristicsW(L"Audio", &idx);
  }
  ~MmcssScope() { if (h) AvRevertMmThreadCharacteristics(h); }
};

// Same fractional box filter as src/shared/pcm.js Downsampler, so native and renderer paths
// feed Deepgram identically shaped audio.
class Resampler {
 public:
  explicit Resampler(double inRate) : ratio_(inRate / kRate) {}
  void Process(const std::vector<float>& x, std::vector<int16_t>& out) {
    if (std::fabs(ratio_ - 1.0) < 1e-9) {
      for (float s : x) out.push_back(ToI16(s));
      return;
    }
    buf_.insert(buf_.end(), x.begin(), x.end());
    double pos = pos_;
    const double r = ratio_;
    const size_t n = buf_.size();
    while (pos + r <= static_cast<double>(n) + 1e-9) {
      const double end = pos + r;
      double sum = 0;
      const size_t hi = std::min(static_cast<size_t>(std::ceil(end)), n);
      for (size_t i = static_cast<size_t>(std::floor(pos)); i < hi; ++i) {
        sum += buf_[i] * (std::min(static_cast<double>(i + 1), end) - std::max(static_cast<double>(i), pos));
      }
      out.push_back(ToI16(static_cast<float>(sum / r)));
      pos = end;
    }
    const size_t drop = std::min(static_cast<size_t>(std::floor(pos)), n);
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(drop));
    pos_ = pos - static_cast<double>(drop);
  }
  static int16_t ToI16(float s) {
    s = std::max(-1.0f, std::min(1.0f, s));
    return static_cast<int16_t>(std::lround(s < 0 ? s * 32768.0f : s * 32767.0f));
  }

 private:
  double ratio_;
  std::vector<float> buf_;
  double pos_ = 0;
};

// Converts one WASAPI packet in the device mix format to mono float.
class SampleReader {
 public:
  explicit SampleReader(const WAVEFORMATEX* w) : channels_(w->nChannels), bits_(w->wBitsPerSample), align_(w->nBlockAlign) {
    isFloat_ = w->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (w->wFormatTag == WAVE_FORMAT_EXTENSIBLE && w->cbSize >= 22) {
      const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(w);
      isFloat_ = IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != 0;
    }
  }
  void ToMono(const BYTE* data, UINT32 frames, bool silent, std::vector<float>& out) const {
    out.assign(frames, 0.0f);
    if (silent || !data || channels_ == 0) return;
    for (UINT32 f = 0; f < frames; ++f) {
      const BYTE* p = data + static_cast<size_t>(f) * align_;
      float acc = 0;
      for (int c = 0; c < channels_; ++c) acc += Sample(p, c);
      out[f] = acc / channels_;
    }
  }
  bool Supported() const { return isFloat_ ? bits_ == 32 : (bits_ == 16 || bits_ == 24 || bits_ == 32); }

 private:
  float Sample(const BYTE* frame, int c) const {
    if (isFloat_) return reinterpret_cast<const float*>(frame)[c];
    if (bits_ == 16) return reinterpret_cast<const int16_t*>(frame)[c] / 32768.0f;
    if (bits_ == 32) return static_cast<float>(reinterpret_cast<const int32_t*>(frame)[c] / 2147483648.0);
    const BYTE* s = frame + c * 3;  // packed 24-bit
    int32_t v = (static_cast<int32_t>(s[2]) << 24) | (static_cast<int32_t>(s[1]) << 16) | (static_cast<int32_t>(s[0]) << 8);
    return static_cast<float>(v / 2147483648.0);
  }
  int channels_;
  int bits_;
  int align_;
  bool isFloat_ = false;
};

// Collects 16 kHz samples into fixed frames and hands them to the engine.
class Assembler {
 public:
  Assembler(Engine* e, int ch, int n) : e_(e), ch_(ch), n_(static_cast<size_t>(n)) { buf_.reserve(n_); }
  // startMs = QPC ms of samples[0].
  void Push(const int16_t* s, size_t count, double startMs) {
    ChannelStats& st = e_->Stats(ch_);
    const int64_t now = Engine::QpcNow();
    if (st.firstQpc.load() == 0) {
      st.firstQpc = now;
      st.baseSamples = count;
    }
    st.lastQpc = now;
    st.samples += count;
    for (size_t i = 0; i < count; ++i) {
      if (buf_.empty()) frameStartMs_ = startMs + static_cast<double>(i) * 1000.0 / kRate;
      buf_.push_back(s[i]);
      if (buf_.size() == n_) Emit();
    }
  }

 private:
  void Emit() {
    double sq = 0;
    for (int16_t v : buf_) sq += (v / 32768.0) * (v / 32768.0);
    auto* f = new Frame();
    f->channel = ch_;
    f->level = static_cast<float>(std::min(1.0, std::sqrt(sq / static_cast<double>(buf_.size()))));
    f->tsMs = frameStartMs_;
    f->seq = seq_++;
    f->pcm.swap(buf_);
    buf_.clear();
    buf_.reserve(n_);
    e_->Stats(ch_).frames++;
    e_->Deliver(f);
  }
  Engine* e_;
  int ch_;
  size_t n_;
  std::vector<int16_t> buf_;
  double frameStartMs_ = 0;
  uint64_t seq_ = 0;
};

// Minimal IMediaBuffer over a caller-owned byte array (the DSP writes its output here).
class MediaBuffer : public IMediaBuffer {
 public:
  MediaBuffer(BYTE* data, DWORD max) : data_(data), max_(max) {}
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IMediaBuffer) {
      *ppv = static_cast<IMediaBuffer*>(this);
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return 2; }  // stack-owned
  STDMETHODIMP_(ULONG) Release() override { return 1; }
  STDMETHODIMP SetLength(DWORD len) override {
    if (len > max_) return E_INVALIDARG;
    len_ = len;
    return S_OK;
  }
  STDMETHODIMP GetMaxLength(DWORD* p) override {
    if (!p) return E_POINTER;
    *p = max_;
    return S_OK;
  }
  STDMETHODIMP GetBufferAndLength(BYTE** pp, DWORD* pl) override {
    if (pp) *pp = data_;
    if (pl) *pl = len_;
    return S_OK;
  }

 private:
  BYTE* data_;
  DWORD max_;
  DWORD len_ = 0;
};

class NotificationClient : public IMMNotificationClient {
 public:
  explicit NotificationClient(Engine* e) : e_(e) {}
  STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == __uuidof(IMMNotificationClient)) {
      *ppv = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++ref_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = --ref_;
    if (r == 0) delete this;
    return r;
  }
  STDMETHODIMP OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) override {
    if (role == eConsole) e_->Event("device", flow == eRender ? "them" : "me", "default-changed");
    return S_OK;
  }
  STDMETHODIMP OnDeviceStateChanged(LPCWSTR, DWORD state) override {
    const char* s = state == DEVICE_STATE_ACTIVE ? "active" : state == DEVICE_STATE_UNPLUGGED ? "unplugged"
                  : state == DEVICE_STATE_DISABLED ? "disabled" : "not-present";
    e_->Event("device", "", std::string("state-changed:") + s);
    return S_OK;
  }
  STDMETHODIMP OnDeviceAdded(LPCWSTR) override { return S_OK; }
  STDMETHODIMP OnDeviceRemoved(LPCWSTR) override { return S_OK; }
  STDMETHODIMP OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  Engine* e_;
  std::atomic<ULONG> ref_{1};
};

HRESULT SetI4(IPropertyStore* ps, const PROPERTYKEY& key, LONG v) {
  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_I4;
  pv.lVal = v;
  return ps->SetValue(key, pv);
}

HRESULT SetBool(IPropertyStore* ps, const PROPERTYKEY& key, bool v) {
  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BOOL;
  pv.boolVal = v ? VARIANT_TRUE : VARIANT_FALSE;
  return ps->SetValue(key, pv);
}

// Index of the default (console) endpoint in the active-endpoint collection, which is how the
// Voice Capture DSP addresses devices (MFPKEY_WMAAECMA_DEVICE_INDEXES).
int DefaultIndex(IMMDeviceEnumerator* en, EDataFlow flow, std::string* err) {
  ComPtr<IMMDevice> def;
  HRESULT hr = en->GetDefaultAudioEndpoint(flow, eConsole, &def);
  if (FAILED(hr)) { *err = Hr(flow == eRender ? "default render device" : "default microphone", hr); return -1; }
  LPWSTR defId = nullptr;
  def->GetId(&defId);
  ComPtr<IMMDeviceCollection> col;
  hr = en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col);
  UINT n = 0;
  if (SUCCEEDED(hr)) col->GetCount(&n);
  int found = -1;
  for (UINT i = 0; i < n && found < 0; ++i) {
    ComPtr<IMMDevice> d;
    LPWSTR id = nullptr;
    if (SUCCEEDED(col->Item(i, &d)) && SUCCEEDED(d->GetId(&id))) {
      if (defId && wcscmp(id, defId) == 0) found = static_cast<int>(i);
      CoTaskMemFree(id);
    }
  }
  CoTaskMemFree(defId);
  if (found < 0) *err = "default device not found among active endpoints";
  return found;
}

void ListFlow(IMMDeviceEnumerator* en, EDataFlow flow, std::vector<DeviceInfo>* out) {
  ComPtr<IMMDevice> def;
  LPWSTR defId = nullptr;
  if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eConsole, &def))) def->GetId(&defId);
  ComPtr<IMMDeviceCollection> col;
  UINT n = 0;
  if (FAILED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col)) || FAILED(col->GetCount(&n))) n = 0;
  for (UINT i = 0; i < n; ++i) {
    ComPtr<IMMDevice> d;
    if (FAILED(col->Item(i, &d))) continue;
    DeviceInfo info;
    LPWSTR id = nullptr;
    if (SUCCEEDED(d->GetId(&id))) {
      info.id = Utf8(id);
      info.isDefault = defId && wcscmp(id, defId) == 0;
      CoTaskMemFree(id);
    }
    ComPtr<IPropertyStore> props;
    if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT pv;
      PropVariantInit(&pv);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR) info.name = Utf8(pv.pwszVal);
      PropVariantClear(&pv);
    }
    out->push_back(info);
  }
  CoTaskMemFree(defId);
}

}  // namespace

const char* ChannelName(int ch) { return ch >= 0 && ch < kChannelCount ? kNames[ch] : "unknown"; }

int64_t Engine::QpcNow() {
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return t.QuadPart;
}

double Engine::QpcToMs(int64_t qpc) { return static_cast<double>(qpc) * 1000.0 / QpcFreq(); }

Engine::~Engine() { Stop(); }

bool Engine::Running() {
  std::lock_guard<std::mutex> lk(mu_);
  return running_;
}

void Engine::Deliver(Frame* f) {
  const int ch = f->channel;
  if (!frames_ || !frames_(f)) {
    delete f;
    stats_[ch].queueDrops++;
  }
}

void Engine::Event(const std::string& type, const std::string& channel, const std::string& detail) {
  if (events_) events_(type, channel, detail);
}

std::string Engine::Start(const Options& opts, FrameSink frames, EventSink events) {
  std::lock_guard<std::mutex> lk(mu_);
  if (running_) return "native audio is already running";
  if (!opts.them && !opts.me && !opts.meRaw) return "no audio streams requested";
  opts_ = opts;
  if (opts_.frameSamples < 160 || opts_.frameSamples > 16000) opts_.frameSamples = 1280;
  frames_ = std::move(frames);
  events_ = std::move(events);
  for (auto& s : stats_) s.Reset();
  stop_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_) return "CreateEvent failed";
  running_ = true;

  std::vector<std::future<std::string>> inits;
  auto spawn = [&](auto fn) {
    std::promise<std::string> p;
    inits.push_back(p.get_future());
    threads_.emplace_back([this, fn, p = std::move(p)]() mutable { (this->*fn)(std::move(p)); });
  };
  // Render silence first so the DSP and loopback find an active render stream immediately.
  if (opts_.keepAlive && (opts_.them || (opts_.me && opts_.aec))) spawn(&Engine::KeepAliveThread);
  spawn(&Engine::MonitorThread);
  if (opts_.them) {
    std::promise<std::string> p;
    inits.push_back(p.get_future());
    threads_.emplace_back([this, p = std::move(p)]() mutable { CaptureThread(kThem, true, std::move(p)); });
  }
  if (opts_.me && opts_.aec) spawn(&Engine::DspThread);
  if (opts_.me && !opts_.aec) {
    std::promise<std::string> p;
    inits.push_back(p.get_future());
    threads_.emplace_back([this, p = std::move(p)]() mutable { CaptureThread(kMe, false, std::move(p)); });
  }
  if (opts_.meRaw) {
    std::promise<std::string> p;
    inits.push_back(p.get_future());
    threads_.emplace_back([this, p = std::move(p)]() mutable { CaptureThread(kMeRaw, false, std::move(p)); });
  }

  std::string err;
  for (auto& f : inits) {
    if (f.wait_for(std::chrono::seconds(6)) != std::future_status::ready) {
      err = "native audio initialisation timed out";
      break;
    }
    std::string r = f.get();
    if (!r.empty()) {
      err = r;
      break;
    }
  }
  if (!err.empty()) StopLocked();
  return err;
}

void Engine::Stop() {
  std::lock_guard<std::mutex> lk(mu_);
  StopLocked();
}

void Engine::StopLocked() {
  if (!running_) return;
  if (stop_) SetEvent(static_cast<HANDLE>(stop_));
  for (auto& t : threads_) {
    if (t.joinable()) t.join();
  }
  threads_.clear();
  if (stop_) CloseHandle(static_cast<HANDLE>(stop_));
  stop_ = nullptr;
  running_ = false;
  frames_ = nullptr;
  events_ = nullptr;
}

void Engine::CaptureThread(int ch, bool loopback, std::promise<std::string> ready) {
  ComScope com;
  MmcssScope mmcss;
  const char* name = ChannelName(ch);
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDevice> dev;
  ComPtr<IAudioClient> ac;
  ComPtr<IAudioCaptureClient> cc;
  WAVEFORMATEX* wfx = nullptr;

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (FAILED(hr)) return ready.set_value(Hr("device enumerator", hr));
  hr = en->GetDefaultAudioEndpoint(loopback ? eRender : eCapture, eConsole, &dev);
  if (FAILED(hr)) return ready.set_value(Hr(loopback ? "default render device" : "default microphone", hr));
  hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(ac.GetAddressOf()));
  if (FAILED(hr)) return ready.set_value(Hr("IAudioClient", hr));
  hr = ac->GetMixFormat(&wfx);
  if (FAILED(hr)) return ready.set_value(Hr("GetMixFormat", hr));
  SampleReader reader(wfx);
  if (!reader.Supported()) {
    CoTaskMemFree(wfx);
    return ready.set_value("unsupported device sample format");
  }
  hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0, kBufferHns, 0, wfx, nullptr);
  if (SUCCEEDED(hr)) hr = ac->GetService(IID_PPV_ARGS(&cc));
  if (SUCCEEDED(hr)) hr = ac->Start();
  if (FAILED(hr)) {
    CoTaskMemFree(wfx);
    return ready.set_value(Hr(loopback ? "loopback capture" : "microphone capture", hr));
  }
  Resampler rs(wfx->nSamplesPerSec);
  {
    char fmt[96];
    std::snprintf(fmt, sizeof(fmt), "format:%luHz/%uch/%ubit", static_cast<unsigned long>(wfx->nSamplesPerSec),
                  static_cast<unsigned>(wfx->nChannels), static_cast<unsigned>(wfx->wBitsPerSample));
    Event("info", name, fmt);
  }
  CoTaskMemFree(wfx);
  wfx = nullptr;
  Assembler asmb(this, ch, opts_.frameSamples);
  ready.set_value("");

  std::vector<float> mono;
  std::vector<int16_t> out;
  bool first = true;
  bool failed = false;
  while (!failed && WaitForSingleObject(static_cast<HANDLE>(stop_), 10) == WAIT_TIMEOUT) {
    for (;;) {
      UINT32 next = 0;
      hr = cc->GetNextPacketSize(&next);
      if (FAILED(hr)) {
        Event("error", name, hr == AUDCLNT_E_DEVICE_INVALIDATED ? "device-invalidated" : Hr("GetNextPacketSize", hr));
        failed = true;
        break;
      }
      if (next == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      UINT64 qpcPos = 0;
      hr = cc->GetBuffer(&data, &frames, &flags, nullptr, &qpcPos);
      if (FAILED(hr)) {
        Event("error", name, hr == AUDCLNT_E_DEVICE_INVALIDATED ? "device-invalidated" : Hr("GetBuffer", hr));
        failed = true;
        break;
      }
      if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && !first) stats_[ch].discontinuities++;
      first = false;
      reader.ToMono(data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0, mono);
      cc->ReleaseBuffer(frames);
      out.clear();
      rs.Process(mono, out);
      // qpcPos is in 100 ns units of the performance counter.
      const double startMs = (qpcPos && !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) ? qpcPos / 10000.0 : QpcToMs(QpcNow());
      if (!out.empty()) asmb.Push(out.data(), out.size(), startMs);
    }
  }
  ac->Stop();
}

void Engine::DspThread(std::promise<std::string> ready) {
  ComScope com;
  MmcssScope mmcss;
  ComPtr<IMMDeviceEnumerator> en;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (FAILED(hr)) return ready.set_value(Hr("device enumerator", hr));
  std::string err;
  const int mic = DefaultIndex(en.Get(), eCapture, &err);
  if (mic < 0) return ready.set_value(err);
  const int spk = DefaultIndex(en.Get(), eRender, &err);
  if (spk < 0) return ready.set_value(err);

  ComPtr<IMediaObject> dmo;
  hr = CoCreateInstance(CLSID_CWMAudioAEC, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dmo));
  if (FAILED(hr)) return ready.set_value(Hr("Voice Capture DSP", hr));
  ComPtr<IPropertyStore> ps;
  hr = dmo.As(&ps);
  if (FAILED(hr)) return ready.set_value(Hr("DSP property store", hr));
  hr = SetI4(ps.Get(), MFPKEY_WMAAECMA_SYSTEM_MODE, opts_.arrayMode ? OPTIBEAM_ARRAY_AND_AEC : SINGLE_CHANNEL_AEC);
  if (SUCCEEDED(hr)) hr = SetI4(ps.Get(), MFPKEY_WMAAECMA_DEVICE_INDEXES, static_cast<LONG>((static_cast<unsigned long>(spk) << 16) | (static_cast<unsigned long>(mic) & 0xFFFF)));
  if (SUCCEEDED(hr)) hr = SetBool(ps.Get(), MFPKEY_WMAAECMA_FEATURE_MODE, true);
  if (SUCCEEDED(hr)) hr = SetI4(ps.Get(), MFPKEY_WMAAECMA_FEATR_NS, opts_.ns ? 1 : 0);
  if (SUCCEEDED(hr)) hr = SetBool(ps.Get(), MFPKEY_WMAAECMA_FEATR_AGC, opts_.agc);
  if (SUCCEEDED(hr)) hr = SetI4(ps.Get(), MFPKEY_WMAAECMA_FEATR_AES, std::max(0, std::min(2, opts_.aes)));
  if (SUCCEEDED(hr)) {
    const int len = opts_.echoLengthMs;
    hr = SetI4(ps.Get(), MFPKEY_WMAAECMA_FEATR_ECHO_LENGTH, (len == 128 || len == 512 || len == 1024) ? len : 256);
  }
  if (FAILED(hr)) return ready.set_value(Hr("DSP configuration", hr));

  DMO_MEDIA_TYPE mt = {};
  hr = MoInitMediaType(&mt, sizeof(WAVEFORMATEX));
  if (FAILED(hr)) return ready.set_value(Hr("MoInitMediaType", hr));
  mt.majortype = MEDIATYPE_Audio;
  mt.subtype = MEDIASUBTYPE_PCM;
  mt.lSampleSize = 0;
  mt.bFixedSizeSamples = TRUE;
  mt.bTemporalCompression = FALSE;
  mt.formattype = FORMAT_WaveFormatEx;
  auto* w = reinterpret_cast<WAVEFORMATEX*>(mt.pbFormat);
  w->wFormatTag = WAVE_FORMAT_PCM;
  w->nChannels = 1;
  w->nSamplesPerSec = kRate;
  w->nAvgBytesPerSec = kRate * 2;
  w->nBlockAlign = 2;
  w->wBitsPerSample = 16;
  w->cbSize = 0;
  hr = dmo->SetOutputType(0, &mt, 0);
  MoFreeMediaType(&mt);
  if (FAILED(hr)) return ready.set_value(Hr("DSP output type", hr));
  hr = dmo->AllocateStreamingResources();
  if (FAILED(hr)) return ready.set_value(Hr("DSP streaming resources", hr));

  std::vector<BYTE> outBytes(kRate * 2);  // 1 s
  MediaBuffer mb(outBytes.data(), static_cast<DWORD>(outBytes.size()));
  DMO_OUTPUT_DATA_BUFFER odb = {};
  odb.pBuffer = &mb;
  Assembler asmb(this, kMe, opts_.frameSamples);

  // The DSP opens its devices on the first ProcessOutput; a hard failure there is an init failure.
  bool readySent = false;
  bool warnedNoRender = false;
  const auto t0 = std::chrono::steady_clock::now();
  while (WaitForSingleObject(static_cast<HANDLE>(stop_), 10) == WAIT_TIMEOUT) {
    bool failed = false;
    do {
      mb.SetLength(0);
      odb.dwStatus = 0;
      DWORD status = 0;
      hr = dmo->ProcessOutput(0, 1, &odb, &status);
      if (hr == WMAAECMA_E_NO_ACTIVE_RENDER_STREAM) {
        stats_[kMe].noRenderStream++;
        if (!warnedNoRender) {
          warnedNoRender = true;
          Event("warning", "me", "aec-no-render-stream");
        }
        break;
      }
      if (FAILED(hr)) {
        if (!readySent) {
          ready.set_value(Hr("DSP ProcessOutput", hr));
          dmo->FreeStreamingResources();
          return;
        }
        Event("error", "me", hr == AUDCLNT_E_DEVICE_INVALIDATED ? "device-invalidated" : Hr("DSP ProcessOutput", hr));
        failed = true;
        break;
      }
      BYTE* p = nullptr;
      DWORD len = 0;
      mb.GetBufferAndLength(&p, &len);
      if (len >= 2) {
        const size_t n = len / 2;
        asmb.Push(reinterpret_cast<const int16_t*>(p), n, QpcToMs(QpcNow()) - n * 1000.0 / kRate);
      }
    } while (odb.dwStatus & DMO_OUTPUT_DATA_BUFFERF_INCOMPLETE);
    if (failed) break;
    if (!readySent && (stats_[kMe].samples.load() > 0 || std::chrono::steady_clock::now() - t0 > std::chrono::milliseconds(400))) {
      readySent = true;
      ready.set_value("");
    }
  }
  if (!readySent) ready.set_value("");  // stopped during init
  dmo->FreeStreamingResources();
}

void Engine::KeepAliveThread(std::promise<std::string> ready) {
  ComScope com;
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDevice> dev;
  ComPtr<IAudioClient> ac;
  ComPtr<IAudioRenderClient> rc;
  WAVEFORMATEX* wfx = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (SUCCEEDED(hr)) hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(ac.GetAddressOf()));
  if (SUCCEEDED(hr)) hr = ac->GetMixFormat(&wfx);
  if (SUCCEEDED(hr)) hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, kBufferHns, 0, wfx, nullptr);
  if (wfx) CoTaskMemFree(wfx);
  UINT32 bufferFrames = 0;
  if (SUCCEEDED(hr)) hr = ac->GetBufferSize(&bufferFrames);
  if (SUCCEEDED(hr)) hr = ac->GetService(IID_PPV_ARGS(&rc));
  if (SUCCEEDED(hr)) hr = ac->Start();
  // Not fatal: without it loopback and the DSP still work whenever something else is playing.
  if (FAILED(hr)) Event("warning", "them", Hr("silent keep-alive render stream", hr));
  ready.set_value("");
  if (FAILED(hr)) return;
  while (WaitForSingleObject(static_cast<HANDLE>(stop_), 20) == WAIT_TIMEOUT) {
    UINT32 padding = 0;
    if (FAILED(ac->GetCurrentPadding(&padding))) break;
    const UINT32 avail = bufferFrames - padding;
    if (!avail) continue;
    BYTE* data = nullptr;
    if (SUCCEEDED(rc->GetBuffer(avail, &data))) rc->ReleaseBuffer(avail, AUDCLNT_BUFFERFLAGS_SILENT);
  }
  ac->Stop();
}

void Engine::MonitorThread(std::promise<std::string> ready) {
  ComScope com;
  ComPtr<IMMDeviceEnumerator> en;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  auto* client = new NotificationClient(this);
  if (SUCCEEDED(hr)) hr = en->RegisterEndpointNotificationCallback(client);
  if (FAILED(hr)) Event("warning", "", Hr("device notifications", hr));
  ready.set_value("");
  if (SUCCEEDED(hr)) {
    WaitForSingleObject(static_cast<HANDLE>(stop_), INFINITE);
    en->UnregisterEndpointNotificationCallback(client);
  }
  client->Release();
}

std::string Engine::ListDevices(std::vector<DeviceInfo>* render, std::vector<DeviceInfo>* capture) {
  std::string err;
  // Own MTA thread: the caller may be Electron's STA main thread.
  std::thread t([&] {
    ComScope com;
    ComPtr<IMMDeviceEnumerator> en;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (FAILED(hr)) {
      err = Hr("device enumerator", hr);
      return;
    }
    ListFlow(en.Get(), eRender, render);
    ListFlow(en.Get(), eCapture, capture);
  });
  t.join();
  return err;
}

}  // namespace fabel
