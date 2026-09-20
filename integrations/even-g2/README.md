# CanvasTTY for Even G2

This companion adapts CanvasTTY's terminal and agent workflows to Even G2 glasses. It includes a phone connection/control interface, glasses HUD, push-to-talk dictation, session creation, rename/close confirmations and a More agents picker. The desktop integration is opt-in under **Settings → Controls → Even G2**.

Use six-digit local pairing on the same network, then approve access on the Mac. Speech recognition runs locally with Nemotron through the bundled helper or an existing supported Handy installation. Each agent still requires its own installed CLI and account on the computer.

See [setup, transport, permissions, speech and acceptance](../../docs/even-g2.md). Run commands from the repository root:

```sh
npm ci
npm run test:even
npm run build
npm run pack:even
```

The packer produces `integrations/even-g2/release/canvastty-even-g2-0.5.6.ehpk`. The generic package uses eight literal local discovery origins; packaging rejects undeclared URLs before producing the archive. No machine-specific address is needed.

Version 0.5.6 is submitted for Even Hub review. A public store release and a compatible public desktop installer are not yet available. The source branch includes integration with newer upstream providers; its rebuilt package is separate from the submitted artifact. The companion UI is currently Russian; a complete English localization is not claimed.
