{
  "targets": [{
    "target_name": "browser-gestures",
    "sources": ["monitor.mm"],
    "defines": ["NAPI_VERSION=8"],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "CLANG_ENABLE_OBJC_ARC": "YES",
      "MACOSX_DEPLOYMENT_TARGET": "11.0",
      "OTHER_LDFLAGS": ["-framework", "AppKit"]
    }
  }]
}
