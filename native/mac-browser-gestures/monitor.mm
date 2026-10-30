#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>
#include <cstdint>

namespace {
id monitor;
__weak NSView* rootView;
napi_env environment;
napi_ref callback;
napi_async_context context;
uintptr_t subscription = 0;

void Stop(void*) {
  if (monitor) { [NSEvent removeMonitor:monitor]; monitor = nil; }
  rootView = nil;
  if (callback) { napi_delete_reference(environment, callback); callback = nullptr; }
  if (context) { napi_async_destroy(environment, context); context = nullptr; }
}

void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, key, number);
}

napi_value StopCallback(napi_env env, napi_callback_info info) {
  void* token;
  napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &token);
  if (reinterpret_cast<uintptr_t>(token) == subscription) Stop(nullptr);
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value Start(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  bool isBuffer = false; napi_valuetype type;
  if (count != 2 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer
      || napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected native window handle and callback"); return nullptr;
  }
  void* data; size_t size;
  napi_get_buffer_info(env, args[0], &data, &size);
  if (size != sizeof(void*) || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "Invalid main-thread native window handle"); return nullptr;
  }
  void* pointer; std::memcpy(&pointer, data, sizeof(pointer));
  if (!pointer) { napi_throw_type_error(env, nullptr, "Empty native window handle"); return nullptr; }
  environment = env; Stop(nullptr);
  ++subscription;
  rootView = (__bridge NSView*)pointer;
  napi_create_reference(env, args[1], 1, &callback);
  napi_value resource, name;
  napi_create_object(env, &resource);
  napi_create_string_utf8(env, "browser-scroll-phase", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, resource, name, &context);
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent*(NSEvent* event) {
    NSView* view = rootView;
    if (!view || event.window != view.window) return event;
    NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
    napi_handle_scope scope; napi_open_handle_scope(env, &scope);
    napi_value fn, global, payload, result;
    napi_get_reference_value(env, callback, &fn); napi_get_global(env, &global); napi_create_object(env, &payload);
    SetNumber(env, payload, "phase", event.phase);
    SetNumber(env, payload, "momentumPhase", event.momentumPhase);
    SetNumber(env, payload, "x", point.x);
    SetNumber(env, payload, "y", view.isFlipped ? point.y : view.bounds.size.height - point.y);
    // Only this application's scroll phases are observed; delivery and scrolling stay untouched.
    napi_status status = napi_make_callback(env, context, global, fn, 1, &payload, &result);
    if (status == napi_pending_exception) {
      napi_value error; napi_get_and_clear_last_exception(env, &error); napi_fatal_exception(env, error);
    }
    napi_close_handle_scope(env, scope);
    return event;
  }];
  if (!monitor) { Stop(nullptr); napi_throw_error(env, nullptr, "Could not observe local scroll phases"); return nullptr; }
  napi_value stop; napi_create_function(env, "stop", NAPI_AUTO_LENGTH, StopCallback, reinterpret_cast<void*>(subscription), &stop); return stop;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value start; napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &start);
  napi_set_named_property(env, exports, "start", start);
  napi_add_env_cleanup_hook(env, Stop, nullptr);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
