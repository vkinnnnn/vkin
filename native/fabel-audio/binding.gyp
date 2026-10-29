{
  "targets": [
    {
      "target_name": "fabel_audio",
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "sources": ["src/addon.cc", "src/engine.cc"],
          "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
          "libraries": [
            "ole32.lib", "uuid.lib", "msdmo.lib", "dmoguids.lib", "wmcodecdspuuid.lib",
            "strmiids.lib", "avrt.lib", "propsys.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/W3"] }
          }
        }, {
          "sources": ["src/stub.cc"]
        }]
      ]
    }
  ]
}
