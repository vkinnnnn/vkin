// FABEL native audio engine (Windows). Captures:
//   them  - system-output loopback of the default render device (WASAPI shared loopback)
//   me    - the default microphone, echo-cancelled by the Windows Voice Capture DSP
//           (CLSID_CWMAudioAEC, SINGLE_CHANNEL_AEC) using the render loopback as the reference,
//           or the raw microphone when aec=false
//   meRaw - the raw microphone in parallel (A/B measurement only; never sent to STT)
// Everything is delivered as 16 kHz mono Int16 frames with QPC-based timestamps.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace fabel {

enum Channel { kThem = 0, kMe = 1, kMeRaw = 2, kChannelCount = 3 };
const char* ChannelName(int ch);

struct Options {
  bool them = true;
  bool me = true;
  bool aec = true;
  bool meRaw = false;
  bool ns = false;        // DSP noise suppression: off unless measured to help (PRD)
  bool agc = false;       // DSP automatic gain control
  bool keepAlive = true;  // render silence so loopback and the DSP always see an active render stream
  int frameSamples = 1280;  // 80 ms at 16 kHz (Deepgram Flux chunk size)
  int aes = 1;              // DSP residual echo suppression passes (0..2). Windows default 0 leaked 18/21 played words into STT; 1 leaked 0 (probe 2026-10-17)
  int echoLengthMs = 256;   // DSP echo tail: 128, 256, 512 or 1024
  bool arrayMode = false;   // OPTIBEAM_ARRAY_AND_AEC (mic arrays with driver geometry) instead of SINGLE_CHANNEL_AEC
};

struct Frame {
  int channel = 0;
  std::vector<int16_t> pcm;
  double tsMs = 0;   // QPC-based monotonic ms of the first sample (approximate)
  float level = 0;   // RMS, 0..1
  uint64_t seq = 0;  // per-channel frame counter
};

struct ChannelStats {
  std::atomic<uint64_t> frames{0};
  std::atomic<uint64_t> samples{0};
  std::atomic<uint64_t> discontinuities{0};
  std::atomic<uint64_t> queueDrops{0};
  std::atomic<uint64_t> noRenderStream{0};
  std::atomic<uint64_t> baseSamples{0};  // samples in the first packet (already buffered before firstQpc)
  std::atomic<int64_t> firstQpc{0};
  std::atomic<int64_t> lastQpc{0};
  void Reset() {
    frames = 0; samples = 0; discontinuities = 0; queueDrops = 0; noRenderStream = 0; baseSamples = 0; firstQpc = 0; lastQpc = 0;
  }
};

struct DeviceInfo {
  std::string id;
  std::string name;
  bool isDefault = false;
};

class Engine {
 public:
  // FrameSink takes ownership on success (returns true); on false the engine frees the frame
  // and counts a queue drop, so a stalled consumer can never grow memory without bound.
  using FrameSink = std::function<bool(Frame*)>;
  using EventSink = std::function<void(const std::string& type, const std::string& channel, const std::string& detail)>;

  Engine() = default;
  ~Engine();

  // Synchronous: returns "" when every requested stream initialised, otherwise an error message
  // with nothing left running (the caller then falls back to renderer capture).
  std::string Start(const Options& opts, FrameSink frames, EventSink events);
  void Stop();
  bool Running();
  const Options& Opts() const { return opts_; }
  ChannelStats& Stats(int ch) { return stats_[ch]; }

  void Deliver(Frame* f);
  void Event(const std::string& type, const std::string& channel, const std::string& detail);

  static std::string ListDevices(std::vector<DeviceInfo>* render, std::vector<DeviceInfo>* capture);
  static double QpcToMs(int64_t qpc);
  static int64_t QpcNow();

 private:
  void StopLocked();
  void CaptureThread(int ch, bool loopback, std::promise<std::string> ready);
  void DspThread(std::promise<std::string> ready);
  void KeepAliveThread(std::promise<std::string> ready);
  void MonitorThread(std::promise<std::string> ready);

  std::mutex mu_;
  bool running_ = false;
  Options opts_;
  FrameSink frames_;
  EventSink events_;
  void* stop_ = nullptr;  // manual-reset event HANDLE
  std::vector<std::thread> threads_;
  ChannelStats stats_[kChannelCount];
};

}  // namespace fabel
