# Even G2 local companion

CanvasTTY's **Settings → Controls → Even G2** connects the desktop to an installed Even App companion. Both live in this repository. The desktop retains the original CanvasTTY name, application ID, and desktop version. The companion version is **0.5.6**. Integration is off by default.

## Connect

1. Build this integration branch of CanvasTTY and install its matching companion through an available Even Hub test channel. Open the companion in Even App with the glasses connected to the phone. The ordinary upstream release does not yet include this integration.
2. Put the Mac and phone on the same local network. In CanvasTTY, open **Settings → Controls → Even G2 → Connect Even G2**. Existing valid settings open the connection code directly. The Access tab lets you choose a project folder, shared sessions and permissions.
3. Enter the **six digits** shown on Mac into the companion’s Code field. Tap **Connect computer**.
4. Approve the pending connection on Mac. The companion saves its connection using Even App storage. No camera, QR, domain, account with a relay service, ADB, USB forwarding or separately launched tunnel is required for app traffic.

The code is valid for two minutes. The generic companion discovers one of eight reserved local Bonjour names, then verifies the PIN with SRP-6a before receiving the encrypted connection key. No address or key is entered manually. Older CT- tokens and eight-digit codes are rejected.

Local discovery currently targets macOS and requires local name resolution on the phone. The reported physical acceptance used Wi-Fi with the phone VPN off. VPN compatibility is not established. The integration itself never modifies VPN settings.

The desktop listens only on the selected interface's private IPv4 and ULA IPv6 addresses, never an all-interface or public listener. Bonjour advertises a bound private IPv4 address when available, otherwise the selected bound address. The integration does not modify a VPN, OS firewall or router. A selected address still has to be reachable from the phone; guest-network isolation or unavailable IP families can prevent access.

## Create sessions

The phone offers every CanvasTTY hotbar provider: Terminal, Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, Grok Build, OMP and Pi. On glasses, New Codex and New Terminal retain their direct actions. More agents opens the other agent providers: swipe to choose, click to create, double-click to cancel. Holding while this picker is open does not start dictation.

Creation uses the existing desktop launcher, the shared project folder and the normal launch profile. Each provider still needs its CLI and authentication on the Mac. The integration does not install providers or bypass their login.

## Speech

Recognition runs on Mac. An existing Handy installation/model remains supported, including Nemotron Streaming 3.5. On a new supported Mac, **Access → Voice on this Mac → Prepare Nemotron 3.5** downloads the pinned 716 MiB model, shows progress and checks its SHA-256 before enabling it. Cancel and retry are available.

The packaged native helper uses **transcribe.cpp 0.2.3** and is built for Apple Silicon or Intel macOS. It receives bounded mono PCM16 at 16 kHz through stdin and returns a transcript; it does not record the OS microphone, download while transcribing, or write dictation history. The model stays local. Bundled recognition currently targets macOS; the existing Windows speech path remains unavailable in this preview.

On the glasses, hold to dictate and release to submit. Rename Terminal opens a separate name preview: dictate, review, select Save and click. Name text is never sent as a terminal command. Closing a terminal also requires confirmation. The project-browser action currently opens the existing browser on Mac; full browser navigation from glasses is a separate unfinished feature.

## Connection protection

- The six-digit code authenticates an SRP-6a exchange using the pinned secure-remote-password implementation (2048-bit group, SHA-256). Neither the code nor a reusable PIN-derived encryption key is sent. The client verifies the server proof before accepting the encrypted connection key. Each two-minute offer accepts at most ten handshake starts; a proof can be redeemed once.
- Mac approval remains mandatory. Persisted bearer credentials are stored only in Even App storage; the desktop stores token hashes and scopes. Identity files use private permissions.
- Subsequent requests, responses and PCM are AES-GCM encrypted over local HTTP. Computer identity, packet ID and direction are authenticated. The app rejects public, credential-bearing and malformed connection addresses.
- Existing per-session grants, freshness checks, revocation and request-id replay protection remain enforced. Unknown microphone commands block overlapping native operations; a completed rejection permits a new explicit hold. No recording starts automatically on reconnect.
- Code bootstrap and ordinary API bodies are bounded. Address probes carry no bearer credential. An uncertain mutation is not automatically repeated at another address.

The generic package declares eight exact local HTTP origins (`canvastty.local:3481` through `canvastty-8.local:3481`), matching the desktop discovery service. There are no network wildcards or machine-specific IPs in the release manifest. Private-build networking and public store review remain separate acceptance gates.

## Build

Use the Node version required by the pinned Vite packages and npm workspaces:

```sh
npm ci
npm test
npm run test:even
npm run build
npx electron-builder --dir --mac --arm64 --publish never
npm run pack:even
```

The macOS build downloads a pinned native runtime archive, verifies its hash, compiles the small helper with the matching pinned C header, and packages the runtime/licenses from `artifacts/companion-speech`. Use `CANVASTTY_SPEECH_ARCH=x64` for a matching Intel build. No user models, credentials or local profiles go into the distribution.

Output: `integrations/even-g2/release/canvastty-even-g2-0.5.6.ehpk`. Packing validates the emitted JS/HTML/CSS URLs against `network.whitelist` and writes a `.network-check.json` report alongside the package. No per-computer build variable is needed. The packer's explicit `--fixed-origin` option remains for legacy development only; the normal package uses code-based local pairing.

For isolated desktop testing, provide an absolute `CANVASTTY_USER_DATA_DIR` before launch. The process removes that variable from launched terminals. Changes do not migrate another installation's sessions.

## Acceptance and distribution

The local implementation's 0.5.6 handoff records 622 desktop tests and 47 companion tests, type checking, production builds, a secret scan and successful packaging. Its network preflight rejects the former 0.5.5 dynamic URL template and accepts the eight literal origins in the 0.5.6 bundle. The integration branch is tested again after updating to upstream main; use the PR's CI for its current results.

The user confirmed local pairing, microphone input, terminal interaction, session creation and the More agents menu on their Mac/Android/Even G2 setup before the packaging correction. A new physical install or voice run for 0.5.6 was not performed. Clean-Mac onboarding, USB-detached operation, phone lock/background/reconnect, Intel Mac and other desktop OS device acceptance remain unverified. Pi and OMP were added when integrating current upstream; their glasses menu routes have automated coverage, not fresh device acceptance.

Companion 0.5.6 was submitted for Even Hub review on 15 September 2026. Store approval is pending. GitHub source review is independent of that process. The submitted package is retained separately; rebuilding this branch after upstream integration produces a different artifact and does not replace the store submission.

There is no published compatible installer yet. Build from this branch with the commands above. The Mac bundle uses ad-hoc signing without notarization; it has not been validated as a frictionless install on a clean Mac. Do not direct users to an ordinary CanvasTTY release as a compatible G2 build.

## Security review boundaries

Pairing authenticates the short code and separate device grants control API operations. The current local transport distributes one persistent computer encryption key to paired clients. Revoking a device's API token does not rotate that shared transport key, so per-device confidentiality and forward secrecy are not claimed. An upstream security review should address that trust model before broad distribution. User profiles, pairing state and keys are excluded from source and package contents.

The speech runtime and vendored ABI header include the upstream MIT license; packaging copies the runtime's third-party license directory. The ASR model is downloaded separately after user action and is not committed or bundled. Its model card and terms should be reviewed for the intended distribution.

References: [Even Hub test modes](https://hub.evenrealities.com/docs/test), [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp).
