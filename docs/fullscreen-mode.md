# Fullscreen Mode for Terminal Sessions

CanvasTTY supports fullscreen mode for terminal sessions, allowing you to expand any session to fill the entire viewport for focused work.

## How to Use

### Enter Fullscreen

- **Header button:** Click the maximize icon (⛶) in the terminal card header.
- **Keyboard:** Not yet supported via shortcut (coming soon).

### Exit Fullscreen

- **Close button:** Click the X button in the top-right corner of the fullscreen session.
- **Header button:** Click the restore icon (❐) in the terminal card header.
- **Keyboard:** Press `Escape`.

## Behavior

- **Camera preserved:** When you exit fullscreen, the canvas camera (pan/zoom) stays where you left it. If you navigated during fullscreen, the camera won't snap back.
- **Single session only:** Only one session can be fullscreen at a time. Opening fullscreen for another session automatically closes the previous one.
- **No bounds persistence:** Fullscreen mode is CSS-only — it does not modify the session's saved position or size. If the app crashes during fullscreen, the session restores at its original layout on restart.
- **Header hidden:** The terminal card header and resize handles are hidden in fullscreen, maximizing the terminal surface area.

## Architecture

Fullscreen is implemented as a **CSS overlay layer** separate from the canvas camera transform:

1. `App.tsx` tracks `fullscreenSessionId` state and passes it down to `WorkspaceCanvas`.
2. `WorkspaceCanvas` splits rendering into two groups:
   - **Normal layer** (`workspace__windows`): all sessions *except* the fullscreen one.
   - **Fullscreen layer** (`workspace__fullscreen-layer`): only the fullscreen session, rendered outside the camera transform with `position: absolute; inset: 0`.
3. `TerminalCard` receives a `fullscreen` prop and applies the `terminal-card--fullscreen` CSS class, which overrides dimensions, removes borders/shadows, and hides the header.

This design avoids coordinate-system conflicts between the canvas pan/zoom transform and the fullscreen overlay.

## Internationalization

Fullscreen UI strings are localized in `src/renderer/src/lib/i18n.ts`:

| Key              | English              | Russian                       |
|------------------|----------------------|-------------------------------|
| `enterFullscreen`| Enter fullscreen     | Развернуть на весь экран     |
| `exitFullscreen` | Exit fullscreen      | Свернуть из полноэкранного   |