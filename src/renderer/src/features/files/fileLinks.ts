/**
 * Pure link and image-source classifiers for Markdown rendering. This module
 * carries no React and performs no I/O. It decides which links may be opened
 * externally and which image sources are safe to render inline (embedded data
 * URLs only, never remote or relative sources).
 */

/**
 * True only for absolute `http:`/`https:` URLs. Relative paths, fragment-only
 * anchors, `mailto:`, `javascript:`, `data:`, `ftp:` and unparseable values are
 * rejected.
 */
export function isOpenableLink(href: string | null | undefined): boolean {
  if (typeof href !== "string" || href.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * True only for embedded `data:image/...` sources, so remote and relative
 * images are never rendered with a network request.
 */
export function isEmbeddedImageSource(src: string | null | undefined): boolean {
  if (typeof src !== "string" || src.length === 0) return false;
  return /^data:image\//i.test(src);
}
