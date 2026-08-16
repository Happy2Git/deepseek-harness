# @deepseek-ai/dsh-host-directory-routes

English | [中文](README.zh.md)

Plugin-owned HTTP routes for the context-files panel's directory browsing. The browser panel cannot reach `ctx.directoryPicker` directly, and the core API gateway is a closed contract, so this plugin carries the panel's transport with it: it registers five exact routes on `ctx.webServer` and answers each from the composed `ctx.directoryPicker` browse capability.

- `/dir/list` (`{ path? }`) — one directory level's listing, ancestry, and `truncated` bound. An absent path lists the home directory.
- `/dir/read-text` (`{ path }`) — one file's bounded, decoded text.
- `/dir/read-image` (`{ path }`) — one image file's raw bytes as canonical base64 plus the magic-byte-sniffed media type; the read fails closed (413) past the composed attachment per-file limit and 415 for content that is not PNG/JPEG/WebP/GIF.
- `/dir/injected-docs` (`{ sessionId }`) — one session's injected-document source events filtered from the complete durable log (persistence store plus the live session's unflushed events, deduped by seq); text blocks only, so tool payloads never cross the wire. Optional services (`sessionPersistence`/`sessions`) degrade to an empty fold when absent.
- `/dir/open-path` (`{ path }`) — opens one host path with the OS default application (`open` on macOS, `Invoke-Item` on Windows, `xdg-open` elsewhere) through `dsh-native-command`, without a shell.

Routes fail loudly: a non-`browse` backend answers 400 with its composed kind, missing fields answer 400, and a thrown failure answers 400 with its message. The route handlers never join path segments or resolve against the host working directory; every path is the browse capability's absolute, fully qualified value.

## Model Experience

None, as the routes serve the GUI host's directory-browsing panel; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Minimal open** — `open-path` uses the platform default application only (`open`/`Invoke-Item`/`xdg-open`) and ignores a text-editor intent. The full, intent-aware opener stays in the core `native-path-opener`; nothing else in the panel needs it.
