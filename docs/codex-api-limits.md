# Codex limits behind an API gateway

`codex app-server` reports ChatGPT subscription limits only for its authenticated native account. A custom API profile cannot identify the upstream account from its model name.

For a local OmniRoute gateway, CanvasTTY can read the real Codex connection quota through the installed OmniRoute CLI. Set these variables in CanvasTTY's launch environment:

- `CANVASTTY_OMNIROUTE_BIN`: absolute path to the installed `omniroute` executable (or Windows `.cmd`).
- `CANVASTTY_OMNIROUTE_URL`: the local gateway origin, such as `http://127.0.0.1:20128`.
- `CANVASTTY_OMNIROUTE_CODEX_CONNECTION`: the connection ID used by the inference route.

This is explicit opt-in. The connection must be active and belong to `codex`; update the binding if routing moves to another account. CanvasTTY uses the CLI's existing local management authentication and never reads or copies upstream OAuth credentials. Remote gateways and URL-borne credentials are rejected.

Only API-backed Codex profiles use this fallback. Native profiles retain their normal app-server source. The reader uses the connection-specific live usage endpoint, not the generic synthetic quota/queue signal. It shows only windows actually reported by the provider, including their real duration and reset time. A source key named `session` does not imply a five-hour window.

Gateway observations carry an unknown local account scope and are not attributed to a different local ChatGPT login. Missing configuration keeps the API-profile explanation; unavailable or malformed upstream data never becomes a fabricated quota bar.
