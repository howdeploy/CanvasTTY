# Local Linux native-editor check

This local branch layers keyboard fixes on CanvasTTY PR #103 head
`c61889b0035a67bdd1eed3f95a3d7455df7d2393`. Its optional frontend integration
accepts Linux as well as macOS. The adapted frontend is in the sibling
`codex-macos-tui` checkout, branch `integration/canvastty-linux-native-editing`.
Standard launches without the QA environment variables or bundled frontend keep
using the official CLI.

## Current preparation

- Official Codex 0.159.2 for x86_64 Linux is downloaded in
  `artifacts/codex-native-backend/`; the `codex` symlink targets the extracted
  official executable. The global Codex installation remains unchanged.
- The release archive SHA-256 matches GitHub's asset digest:
  `26586b0d246d41a799b0ef8ee1add370f0fb0721b3709340f28db612381616ea`.
- Rust 1.95.0 is installed alongside the existing toolchains. The adapted frontend
  built successfully at
  `../codex-macos-tui/codex-rs/target/debug/canvastty-codex-tui`.
- CanvasTTY dependencies were installed with `npm ci`; `npm run build`, including
  its TypeScript checks, completed successfully. Application output is in `out/`.
- The application was launched for the user's manual check before the keyboard
  preset changes. No test suite, separate lint or automated UI check was run.
  The new preset controls remain for manual checking after relaunch.

## Build and start for manual checking

From the adapted frontend checkout:

```sh
cd ../codex-macos-tui/codex-rs
rustup toolchain install 1.95.0 --profile minimal
CARGO_PROFILE_DEV_DEBUG=0 rustup run 1.95.0 cargo build --locked -j 6 -p codex-tui --bin canvastty-codex-tui
```

The frontend and CanvasTTY are already built in this workspace. Start the built
app with the optional frontend and a separate CanvasTTY profile:

```sh
cd ../../canvastty
mkdir -p ../ctty-qa
PATH="$PWD/artifacts/codex-native-backend:$PATH" \
CANVASTTY_USER_DATA_DIR="$PWD/../ctty-qa" \
CANVASTTY_CODEX_TUI_QA="$PWD/../codex-macos-tui/codex-rs/target/debug/canvastty-codex-tui" \
CANVASTTY_CODEX_TUI_LAUNCHER_QA="$PWD/../codex-macos-tui/macos/codex-tui-launch.mjs" \
node_modules/.bin/electron .
```

Open a Codex terminal in the app. The prefixed PATH lets the provider registry
resolve the isolated official 0.159.2 executable. The existing launcher checks
that backend version before starting its private app-server and patched frontend.
The separate CanvasTTY profile isolates application settings; Codex retains its
normal authentication/config directory.

Keep the profile path short: browser gateway sockets are created below it and
must fit the Unix socket path limit.

After changing CanvasTTY sources, run `npm run build` again before launching.
For live development, use the same environment with `npm run dev` instead.

## Keyboard presets

Open **Settings → Keyboard shortcuts → Keyboard preset** and select macOS, Windows or Linux.
The initial preset follows the host OS; existing customized shortcuts are kept
as Custom. Selecting a named preset replaces the bindings, while recording an
individual shortcut switches to Custom. All presets use Enter to submit and
Shift+Enter for a newline.

Use the controls directly below the preset to edit canvas, terminal
and Codex editor actions, including alternate submit keys. Optional actions can
be disabled. Duplicate bindings are rejected within the context that handles
them. Canvas focus shortcuts yield to focused terminal and text inputs.

Canvas and terminal shortcuts update immediately. Codex submit/newline shortcuts
apply to new or restarted cards, including the ordinary CLI; each running card
retains its launch bindings. Whole-draft selection requires the optional native
frontend described here and is unavailable in stock Codex. See
[Codex editor shortcuts](getting-started.md#codex-editor-shortcuts) for transport
keys, native aliases and version limits. Other CLIs retain their own editor
keymaps. This optional POSIX frontend has not been ported to Windows.

## Manual behavior to check

Select the Linux preset before checking the defaults below. Also record a custom
submit, newline and whole-draft selection binding, restart the Codex card, and
check that both the startup and initialized composer use the new submit/newline
bindings. Whole-draft selection is available in the initialized composer only.
Include a binding such as Ctrl+L, which would otherwise invoke a global Codex
command, to check editor priority without changing dialog confirmation behavior.

1. With two canvas windows present and Codex input focused, Alt+Up reaches the
   CLI instead of switching canvas focus. Alt+arrow still navigates windows when
   the canvas itself has keyboard focus.
2. Enter submits or queues; Ctrl+Enter and Super+Enter are aliases when delivered
   by the window manager. Shift+Enter adds a newline. Tab completes without sending.
3. Startup draft Enter confirms submission; Shift+Enter adds a newline. Trust,
   resume and approval dialogs retain their ordinary confirmation keys.
4. After initialization, Ctrl+A selects multiline/offscreen draft text. Ctrl+C
   copies it; typing, paste and Backspace replace/delete the selection. Large
   pasted content is copied as actual text rather than its placeholder marker.
5. Ctrl+Shift+V pastes text; Ctrl+V retains CLI image paste. Ctrl+C without a
   selection retains interrupt behavior. Ctrl+Shift+F searches terminal output;
   Ctrl+D restarts an exited terminal.
6. Closing/restarting the card releases the owned backend. Resume selection
   opens the expected session with the selected sandbox/approval launch profile.

Whole-draft selection/copy in the provisional startup composer remains restricted
by its existing input owner; this adaptation adds Ctrl+A to the initialized
composer. This limitation should be assessed before the upstream proposal.

After user validation, prepare an upstream Codex PR for the relevant editor and
keymap behavior. Do not publish this local launcher/backend version restriction
as a required dependency of that proposal.

Backend source: [official 0.159.2 release](https://github.com/openai/codex/releases/tag/rust-v0.159.2).
