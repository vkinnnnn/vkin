// Non-Windows build: the addon loads but reports itself unavailable, so the JS layer keeps the
// renderer capture path. macOS/Linux native capture is a later phase.
#include <node_api.h>

static napi_value Available(napi_env env, napi_callback_info) {
  napi_value v;
  napi_get_boolean(env, false, &v);
  return v;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, nullptr, &fn);
  napi_set_named_property(env, exports, "available", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
