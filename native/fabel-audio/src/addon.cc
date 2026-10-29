// Node-API binding for the native audio engine. Node-API is ABI-stable, so one build loads in
// both Node (probe scripts, tests) and Electron's main process.
//
// JS surface:
//   available() -> true
//   start(options, onFrame, onEvent) -> true, throws Error(message) when any stream fails to start
//     onFrame({channel, pcm: Buffer(Int16LE 16 kHz mono), tsMs, level, seq})
//     onEvent({type: 'error'|'warning'|'device', channel, detail})
//   stop()
//   running() -> boolean
//   stats() -> {them|me|meRaw: {frames, samples, discontinuities, queueDrops, noRenderStream, elapsedMs, ratePpm}}
//   devices() -> {render: [{id, name, isDefault}], capture: [...]}
#include <node_api.h>

#include <memory>
#include <string>

#include "engine.h"

namespace {

fabel::Engine* g_engine = nullptr;
napi_threadsafe_function g_frames = nullptr;
napi_threadsafe_function g_events = nullptr;

constexpr size_t kFrameQueue = 256;  // ~20 s of 80 ms frames per process; beyond that frames drop (counted)
constexpr size_t kEventQueue = 64;

struct EventMsg {
  std::string type;
  std::string channel;
  std::string detail;
};

void Throw(napi_env env, const std::string& msg) { napi_throw_error(env, nullptr, msg.c_str()); }

void SetStr(napi_env env, napi_value obj, const char* key, const std::string& v) {
  napi_value s;
  napi_create_string_utf8(env, v.c_str(), v.size(), &s);
  napi_set_named_property(env, obj, key, s);
}

void SetNum(napi_env env, napi_value obj, const char* key, double v) {
  napi_value n;
  napi_create_double(env, v, &n);
  napi_set_named_property(env, obj, key, n);
}

void SetBoolProp(napi_env env, napi_value obj, const char* key, bool v) {
  napi_value b;
  napi_get_boolean(env, v, &b);
  napi_set_named_property(env, obj, key, b);
}

bool GetBool(napi_env env, napi_value obj, const char* key, bool def) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return def;
  napi_value v;
  napi_valuetype t;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok || napi_typeof(env, v, &t) != napi_ok || t != napi_boolean) return def;
  bool out = def;
  napi_get_value_bool(env, v, &out);
  return out;
}

int GetInt(napi_env env, napi_value obj, const char* key, int def) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return def;
  napi_value v;
  napi_valuetype t;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok || napi_typeof(env, v, &t) != napi_ok || t != napi_number) return def;
  int32_t out = def;
  napi_get_value_int32(env, v, &out);
  return out;
}

void CallFrame(napi_env env, napi_value cb, void*, void* data) {
  std::unique_ptr<fabel::Frame> f(static_cast<fabel::Frame*>(data));
  if (!env || !cb) return;  // tearing down: just free
  napi_value obj, buf, undef;
  void* copy = nullptr;
  napi_create_object(env, &obj);
  SetStr(env, obj, "channel", fabel::ChannelName(f->channel));
  napi_create_buffer_copy(env, f->pcm.size() * sizeof(int16_t), f->pcm.data(), &copy, &buf);
  napi_set_named_property(env, obj, "pcm", buf);
  SetNum(env, obj, "tsMs", f->tsMs);
  SetNum(env, obj, "level", f->level);
  SetNum(env, obj, "seq", static_cast<double>(f->seq));
  napi_get_undefined(env, &undef);
  napi_call_function(env, undef, cb, 1, &obj, nullptr);
}

void CallEvent(napi_env env, napi_value cb, void*, void* data) {
  std::unique_ptr<EventMsg> m(static_cast<EventMsg*>(data));
  if (!env || !cb) return;
  napi_value obj, undef;
  napi_create_object(env, &obj);
  SetStr(env, obj, "type", m->type);
  SetStr(env, obj, "channel", m->channel);
  SetStr(env, obj, "detail", m->detail);
  napi_get_undefined(env, &undef);
  napi_call_function(env, undef, cb, 1, &obj, nullptr);
}

void ReleaseTsfns() {
  if (g_frames) napi_release_threadsafe_function(g_frames, napi_tsfn_abort);
  if (g_events) napi_release_threadsafe_function(g_events, napi_tsfn_abort);
  g_frames = nullptr;
  g_events = nullptr;
}

napi_value Available(napi_env env, napi_callback_info) {
  napi_value v;
  napi_get_boolean(env, true, &v);
  return v;
}

napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype t0, t1, t2;
  if (argc < 3 || napi_typeof(env, args[0], &t0) != napi_ok || napi_typeof(env, args[1], &t1) != napi_ok ||
      napi_typeof(env, args[2], &t2) != napi_ok || t0 != napi_object || t1 != napi_function || t2 != napi_function) {
    Throw(env, "start(options, onFrame, onEvent) expects an object and two functions");
    return nullptr;
  }
  if (g_engine->Running()) {
    Throw(env, "native audio is already running");
    return nullptr;
  }
  fabel::Options o;
  o.them = GetBool(env, args[0], "them", true);
  o.me = GetBool(env, args[0], "me", true);
  o.aec = GetBool(env, args[0], "aec", true);
  o.meRaw = GetBool(env, args[0], "meRaw", false);
  o.ns = GetBool(env, args[0], "ns", false);
  o.agc = GetBool(env, args[0], "agc", false);
  o.keepAlive = GetBool(env, args[0], "keepAlive", true);
  o.frameSamples = GetInt(env, args[0], "frameSamples", 1280);
  o.aes = GetInt(env, args[0], "aes", 1);
  o.echoLengthMs = GetInt(env, args[0], "echoLengthMs", 256);
  o.arrayMode = GetBool(env, args[0], "arrayMode", false);

  napi_value name;
  napi_create_string_utf8(env, "fabel_audio", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, kFrameQueue, 1, nullptr, nullptr, nullptr, CallFrame, &g_frames) != napi_ok ||
      napi_create_threadsafe_function(env, args[2], nullptr, name, kEventQueue, 1, nullptr, nullptr, nullptr, CallEvent, &g_events) != napi_ok) {
    ReleaseTsfns();
    Throw(env, "could not create audio callbacks");
    return nullptr;
  }
  const std::string err = g_engine->Start(
      o,
      [](fabel::Frame* f) { return g_frames && napi_call_threadsafe_function(g_frames, f, napi_tsfn_nonblocking) == napi_ok; },
      [](const std::string& type, const std::string& channel, const std::string& detail) {
        if (!g_events) return;
        auto* m = new EventMsg{type, channel, detail};
        if (napi_call_threadsafe_function(g_events, m, napi_tsfn_nonblocking) != napi_ok) delete m;
      });
  if (!err.empty()) {
    ReleaseTsfns();
    Throw(env, err);
    return nullptr;
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
}

// startAsync(options, onFrame, onEvent) -> Promise<true>. Same as start(), but the device/DSP
// initialisation (about a second for the Voice Capture DSP) runs on a worker thread, so the Electron
// main thread never freezes when capture starts or restarts after a device change.
struct StartWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  fabel::Options opts;
  std::string err;
};

void StartExecute(napi_env, void* data) {
  auto* w = static_cast<StartWork*>(data);
  w->err = g_engine->Start(
      w->opts,
      [](fabel::Frame* f) { return g_frames && napi_call_threadsafe_function(g_frames, f, napi_tsfn_nonblocking) == napi_ok; },
      [](const std::string& type, const std::string& channel, const std::string& detail) {
        if (!g_events) return;
        auto* m = new EventMsg{type, channel, detail};
        if (napi_call_threadsafe_function(g_events, m, napi_tsfn_nonblocking) != napi_ok) delete m;
      });
}

void StartComplete(napi_env env, napi_status, void* data) {
  std::unique_ptr<StartWork> w(static_cast<StartWork*>(data));
  // stop() ran while this start was queued: the callbacks are gone, so never leave capture running.
  if (w->err.empty() && !g_frames) g_engine->Stop();
  if (w->err.empty()) {
    napi_value ok;
    napi_get_boolean(env, true, &ok);
    napi_resolve_deferred(env, w->deferred, ok);
  } else {
    ReleaseTsfns();
    napi_value msg, error;
    napi_create_string_utf8(env, w->err.c_str(), w->err.size(), &msg);
    napi_create_error(env, nullptr, msg, &error);
    napi_reject_deferred(env, w->deferred, error);
  }
  napi_delete_async_work(env, w->work);
}

napi_value StartAsync(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype t0, t1, t2;
  if (argc < 3 || napi_typeof(env, args[0], &t0) != napi_ok || napi_typeof(env, args[1], &t1) != napi_ok ||
      napi_typeof(env, args[2], &t2) != napi_ok || t0 != napi_object || t1 != napi_function || t2 != napi_function) {
    Throw(env, "startAsync(options, onFrame, onEvent) expects an object and two functions");
    return nullptr;
  }
  // g_frames first: Running() waits on the engine lock while another start is initialising.
  if (g_frames || g_engine->Running()) {
    Throw(env, "native audio is already running");
    return nullptr;
  }
  auto* w = new StartWork();
  w->opts.them = GetBool(env, args[0], "them", true);
  w->opts.me = GetBool(env, args[0], "me", true);
  w->opts.aec = GetBool(env, args[0], "aec", true);
  w->opts.meRaw = GetBool(env, args[0], "meRaw", false);
  w->opts.ns = GetBool(env, args[0], "ns", false);
  w->opts.agc = GetBool(env, args[0], "agc", false);
  w->opts.keepAlive = GetBool(env, args[0], "keepAlive", true);
  w->opts.frameSamples = GetInt(env, args[0], "frameSamples", 1280);
  w->opts.aes = GetInt(env, args[0], "aes", 1);
  w->opts.echoLengthMs = GetInt(env, args[0], "echoLengthMs", 256);
  w->opts.arrayMode = GetBool(env, args[0], "arrayMode", false);
  napi_value name;
  napi_create_string_utf8(env, "fabel_audio", NAPI_AUTO_LENGTH, &name);
  // Callbacks are created on the JS thread before any worker can call them.
  if (napi_create_threadsafe_function(env, args[1], nullptr, name, kFrameQueue, 1, nullptr, nullptr, nullptr, CallFrame, &g_frames) != napi_ok ||
      napi_create_threadsafe_function(env, args[2], nullptr, name, kEventQueue, 1, nullptr, nullptr, nullptr, CallEvent, &g_events) != napi_ok) {
    ReleaseTsfns();
    delete w;
    Throw(env, "could not create audio callbacks");
    return nullptr;
  }
  napi_value promise;
  napi_create_promise(env, &w->deferred, &promise);
  napi_value workName;
  napi_create_string_utf8(env, "fabel_audio_start", NAPI_AUTO_LENGTH, &workName);
  napi_create_async_work(env, nullptr, workName, StartExecute, StartComplete, w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

napi_value Stop(napi_env env, napi_callback_info) {
  g_engine->Stop();  // joins every audio thread; nothing calls the tsfns after this
  ReleaseTsfns();
  napi_value u;
  napi_get_undefined(env, &u);
  return u;
}

napi_value Running(napi_env env, napi_callback_info) {
  napi_value v;
  napi_get_boolean(env, g_engine->Running(), &v);
  return v;
}

napi_value Stats(napi_env env, napi_callback_info) {
  napi_value out;
  napi_create_object(env, &out);
  for (int ch = 0; ch < fabel::kChannelCount; ++ch) {
    fabel::ChannelStats& s = g_engine->Stats(ch);
    napi_value o;
    napi_create_object(env, &o);
    const double samples = static_cast<double>(s.samples.load());
    const double measured = samples - static_cast<double>(s.baseSamples.load());
    const int64_t first = s.firstQpc.load();
    const int64_t last = s.lastQpc.load();
    const double elapsedMs = first && last > first ? fabel::Engine::QpcToMs(last - first) : 0;
    SetNum(env, o, "frames", static_cast<double>(s.frames.load()));
    SetNum(env, o, "samples", samples);
    SetNum(env, o, "discontinuities", static_cast<double>(s.discontinuities.load()));
    SetNum(env, o, "queueDrops", static_cast<double>(s.queueDrops.load()));
    SetNum(env, o, "noRenderStream", static_cast<double>(s.noRenderStream.load()));
    SetNum(env, o, "elapsedMs", elapsedMs);
    // Delivered sample rate vs nominal 16 kHz, measured against the QPC clock (needs >10 s to settle).
    SetNum(env, o, "ratePpm", elapsedMs > 0 ? (measured / (elapsedMs / 1000.0) / 16000.0 - 1.0) * 1e6 : 0);
    napi_set_named_property(env, out, fabel::ChannelName(ch), o);
  }
  return out;
}

napi_value DeviceArray(napi_env env, const std::vector<fabel::DeviceInfo>& list) {
  napi_value arr;
  napi_create_array_with_length(env, list.size(), &arr);
  for (size_t i = 0; i < list.size(); ++i) {
    napi_value o;
    napi_create_object(env, &o);
    SetStr(env, o, "id", list[i].id);
    SetStr(env, o, "name", list[i].name);
    SetBoolProp(env, o, "isDefault", list[i].isDefault);
    napi_set_element(env, arr, static_cast<uint32_t>(i), o);
  }
  return arr;
}

napi_value Devices(napi_env env, napi_callback_info) {
  std::vector<fabel::DeviceInfo> render, capture;
  const std::string err = fabel::Engine::ListDevices(&render, &capture);
  if (!err.empty()) {
    Throw(env, err);
    return nullptr;
  }
  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "render", DeviceArray(env, render));
  napi_set_named_property(env, out, "capture", DeviceArray(env, capture));
  return out;
}

void Cleanup(void*) {
  if (g_engine) g_engine->Stop();
}

napi_value Init(napi_env env, napi_value exports) {
  if (!g_engine) g_engine = new fabel::Engine();  // process lifetime; one engine per process
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  const struct {
    const char* name;
    napi_callback fn;
  } fns[] = {{"available", Available}, {"start", Start}, {"startAsync", StartAsync}, {"stop", Stop}, {"running", Running}, {"stats", Stats}, {"devices", Devices}};
  for (const auto& f : fns) {
    napi_value v;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
    napi_set_named_property(env, exports, f.name, v);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
