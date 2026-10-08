# File browser and reader

[English](files.md) · [Docs home](README.md)

CanvasTTY's **Files** card reads project files strictly inside a root you choose, without leaving the canvas. It is a trusted, read-only feature: it never writes, renames, or deletes, and it exposes no arbitrary filesystem access.

## Open a Files card

1. Choose **Files** from the empty-canvas context menu or the `Cmd/Ctrl+K` canvas command palette. A Files card appears on the canvas with a root selection.
2. Move, resize, focus, stack, and close it like any other canvas card. Below `0.5×` zoom it collapses to the shared semantic summary with the root label.
3. In the card, either open a session's working directory or pick a folder on disk.

The card lives entirely on the canvas. Closing it releases its root; opening a new one starts from root selection.

## Roots

A root is the only directory the card can read. Every listing, read, and search is addressed by a path relative to that root.

| Root | How it is chosen | What happens |
|:--|:--|:--|
| **Session working directory** | Select one of the live sessions offered in the card | Main resolves the session ID to its current working directory through the terminal service; the renderer never supplies a path |
| **Picked folder** | Choose the folder button, then pick a folder in the native dialog | Main canonicalizes the folder and registers it for that card |

The renderer receives only an opaque root ID and a display label. Listings, reads, and searches never carry the absolute root path: those calls always pair the root ID with a relative path, and their payloads stay relative. The one exception is a **folder** root's descriptor, which may also carry its chosen canonical path so the card can persist and re-register that folder after relaunch; session-root descriptors omit it, so a session's working directory never crosses the bridge.

## Supported content

- **Markdown** — `.md`, `.markdown`, `.mdown`, and `.mkd` files are rendered as formatted GitHub-Flavored Markdown: headings, lists, task lists, tables, blockquotes, horizontal rules, inline code, and fenced code blocks with syntax highlighting.
- **Code** — recognized code files are syntax-highlighted by the language detected from the file extension, using a palette that matches the active night or day theme. A text file whose language cannot be determined is shown as readable monospaced text without highlighting and without error.
- **Images** — `png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp`, and `svg` are shown as a preview with their media type.
- **Everything else** — binary content and unsupported or oversized files show an explicit non-content state with the reason. CanvasTTY never fabricates or partially decodes placeholder file data.

Rendered Markdown and code are sanitized: raw HTML and scripts are never rendered as live markup, event-handler attributes and dangerous link schemes such as `javascript:` are neutralized, and untrusted content is never injected as raw HTML. Activating an `http(s)` link opens it in the app's built-in browser instead of navigating the viewer, while any other scheme is inert. Only embedded `data:` images render; remote or relative image sources show their alternative text or a placeholder and never trigger a network request.

## Limits

| Limit | Value |
|:--|:--|
| Text read | Leading `2 MB` returned, with a **truncated** marker and the total file size |
| Image read | `25 MB` maximum; larger images report **too large** and return no bytes |
| Directory listing | Up to `2,000` immediate entries |
| Search results | Up to `500` matching files |
| Search depth | Up to `12` directory levels |

Long text reads are bounded rather than rejected: the card shows the leading portion, marks it truncated, and reports the file's total size. Binary detection never returns bytes as if they were text. Rich rendering is skipped above a roughly `250 KB` threshold: larger text and code files fall back to plain selectable monospace text with a notice that rich rendering is disabled, while the `2 MB` read cap and truncation marker still apply.

## Quick open

Type in the card's **Quick open** field to search file names inside the active root. Results are relative paths; select one to open it. Directories skipped during search are `node_modules`, `.git`, `dist`, `out`, `build`, and `.cache`. A query with no matches reports that plainly instead of guessing.

## Persistence and restore

Each Files card persists its root reference, bounds, open file, and expanded folders in app settings, consistent with other canvas entities. On relaunch the root is re-validated: a card whose root still exists restores its bounds, expanded folders, and previously open file, while a root that has moved or disappeared shows an **unavailable** state explaining that it cannot be read instead of reading an unrelated location.

## Security boundaries

- **Reads stay inside registered roots.** A root is either an existing terminal session working directory or a folder the user explicitly picked; there is no path into the filesystem outside one.
- **Relative paths only.** Requests address the root by opaque ID plus a relative path. Absolute paths are rejected.
- **Containment is enforced in main.** Root and target are canonicalized with `realpath` and the target must be the root itself or a descendant. Parent-directory traversal, symlinks that resolve outside the root, and non-regular files (directories, sockets, devices) are rejected, and containment is re-checked around the open.
- **Read-only by design.** There is no write, rename, delete, or arbitrary filesystem capability, and nothing is uploaded; file content stays on the machine and is never logged.
- **No content leaves the boundary.** List, read, and search payloads expose relative paths only. A folder root's descriptor alone may carry its chosen absolute path, solely so restore can re-register it; session roots never expose their working directory.

A file that is sensitive but lives inside a root you chose (for example a project's `.env`) is readable by explicit user action. CanvasTTY never auto-expands a root beyond the directory you opened and never scans outside it.

For service ownership and the `files:*` IPC channels, read [Architecture](ARCHITECTURE.md). For canvas and interaction invariants, read the [UI contract](UI_CONTRACT.md).
