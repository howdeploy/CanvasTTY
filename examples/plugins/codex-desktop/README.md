# CanvasTTY Codex Desktop

[English](README.md) · [Русский](README.ru.md)

Independent plugin by **bbutterm**, inspired by
[Hermes HUD](https://github.com/howdeploy/canvastty-plugin-hermes-hud).
It embeds a real, already running Codex/ChatGPT desktop window inside a canvas
card on Windows. The optional HOME widget opens that card.

## Requirements and installation

- Windows 10/11, Windows PowerShell 5.1 and .NET Framework Windows Forms.
- A CanvasTTY build containing the `desktop:embed` SDK extension from this change.
  `minHostVersion` is informational; stock 1.8.4 does not support it.
- An installed Codex or ChatGPT desktop application, running as the same user and
  at the same elevation as CanvasTTY.

Install this directory as a developer plugin or publish its contents as the root
of `bbutterm/canvastty-plugin-codex-desktop`, then inspect that repository in
Settings → Plugins. Review the **desktop window embedding** permission. No npm
installation, native plugin service, credentials or network permission is needed.

Open the Codex Desktop canvas contribution (or its HOME widget), start the desktop
app normally, choose its window and press **Embed window**. Use **Return to
desktop** to restore it. Closing the card, disabling the plugin, reloading the
renderer or normally exiting CanvasTTY also restores the window. The plugin never
kills or automatically launches another application's process.

## Limits

This is experimental Windows native window hosting, not a portable web embed.
Some GPU surfaces, elevated apps, dialogs and mixed DPI configurations may reject
reparenting or render incorrectly. The host reports an error and restores the
window when attachment fails. Content reflows to the native viewport size when
the canvas zoom changes; it is not a pixel-scaled screenshot. Pan/drag via the
canvas and card chrome; wheel and keyboard inside Codex belong to Codex.

An embedded native window is hidden when its card is offscreen, semantically
collapsed, behind another canvas surface, or covered by a host modal/menu. Opening
the desktop app's own dialogs may still create separate desktop windows.
There is no automatic attachment on restore: selection is explicit each time.

MIT. The host implementation and tests live in CanvasTTY; this package contains
only static sandboxed HTML, CSS and JavaScript.
