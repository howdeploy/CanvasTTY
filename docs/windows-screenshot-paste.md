# Pasting screenshots on Windows

In a Windows Codex terminal card, copy a screenshot with Win+Shift+S, focus the
Codex prompt and press Ctrl+V. CanvasTTY sends the CLI's native image-paste byte
(Control+V) rather than allowing xterm's extended-key protocol to re-encode it.
The CLI must support reading images from the Windows clipboard.

The configured terminal paste shortcut (Ctrl+Shift+V in the Windows preset) also
checks for an image before reading text. Images use the native CLI shortcut;
text continues through xterm's normal paste handling, including bracketed paste.
Without an image, an unbound Ctrl+V retains literal CLI semantics. Other terminal
providers keep their unbound Ctrl+V behavior. No screenshot is submitted
automatically and no clipboard image is uploaded by CanvasTTY.

Clipboard responses are discarded if the terminal has restarted, exited or
unmounted while the read was pending. This change is independent of the desktop
window plugin SDK and needs an updated CanvasTTY build.
