# Canvas 2.0 update scope

This branch builds on 1.8.7. It keeps the normal release version under maintainer control; `npm run package:v2` creates an isolated local alpha, without publishing or replacing the installed release.

## Appearance and Home

- The Appearance tab includes six bundled profiles: Living Forge, Kisa’s Theme, Teo’s Theme, Steampunk Airship, Brutalist Monolith, and Cyberpunk Noodle Bar. Each has nine animated terminal frames across minimal/detailed/master and idle/working/completed.
- Frame apertures and control positions keep terminal output and buttons usable. Pixel motion stays local to the artwork; the background camera does not pan.
- Animated skins and wallpapers support pause, offscreen and hidden-window suspension, and reduced-motion preferences.
- Home gains layout customization, animated avatar/clock media, and clock, countdown and timer settings.
- The theme engine includes agent instructions, media validation, packing tools and testable pixel-animation helpers. See [the engine guide](../design-engine/LIVE_ENGINE.md).
- Applying a bundled profile sets the canvas background, Home avatar and clock, font, color accents, and terminal skin together. Individual wallpaper packages can still be imported in Appearance.

## Files and workspace

- The file explorer opens as a canvas tool, with filesystem navigation and terminal file dragging.
- Canvas file cards and media previews handle supported images, video and audio through the application media path. Decoding still depends on the format and codecs available in Electron.
- Workspace presets save layout/session launch configuration; they cannot restore an external provider's in-memory process state.

## Canvas Duo

Duo connects a host and guest, synchronizes the shared canvas document and terminal operations, and keeps each person's camera local. Host permissions govern guest edits and terminal input; disconnect/revocation must remain enforceable across asynchronous operations. See [connection, permissions and diagnostics](CANVAS-DUO-P2P.ru.md).

The compact Duo panel keeps hosting, joining, and diagnostics visible. Expand the access or cursor sections to configure sharing, cursor style, or nickname. The local connection recorder tracks attempt IDs, elapsed times, transport stages and safe error codes. The Duo panel can copy a bounded report containing version/platform details and up to 200 events. It excludes invitations, secrets, endpoint addresses, file paths and terminal content. Events also enter the existing rotated local application log. Reports are not uploaded automatically.

Direct Internet connectivity remains dependent on NAT/firewall conditions; this branch does not provide an always-available relay. Automated local-DHT socket tests and a packaged macOS diagnostics check do not prove connectivity between arbitrary Internet providers.

Embedding arbitrary native application windows is outside this update.
