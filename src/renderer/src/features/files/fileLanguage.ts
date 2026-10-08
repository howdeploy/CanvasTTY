/**
 * Pure path -> language classification for the file viewer. This module carries
 * no React and performs no I/O. It maps file extensions to highlight.js
 * language ids and flags Markdown so the card can pick a rich renderer.
 */

export const MARKDOWN_EXTENSIONS: readonly string[] = ["md", "markdown", "mdown", "mkd"];

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  toml: "ini",
  kt: "kotlin",
  swift: "swift",
  lua: "lua",
  r: "r",
  pl: "perl",
  diff: "diff",
  patch: "diff",
  makefile: "makefile"
};

function extensionOf(relativePath: string): string | null {
  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === basename.length - 1) return null;
  return basename.slice(dotIndex + 1).toLowerCase();
}

/** True when the lowercased extension is one of the Markdown extensions. */
export function isMarkdownPath(relativePath: string): boolean {
  const extension = extensionOf(relativePath);
  return extension !== null && MARKDOWN_EXTENSIONS.includes(extension);
}

/**
 * Maps a path to a highlight.js language id. Returns null for unknown
 * extensions and for Markdown extensions (which take the rich Markdown path).
 */
export function detectFileLanguage(relativePath: string): string | null {
  const extension = extensionOf(relativePath);
  if (extension === null) return null;
  if (MARKDOWN_EXTENSIONS.includes(extension)) return null;
  return EXTENSION_LANGUAGE_MAP[extension] ?? null;
}

/**
 * Sorted, de-duplicated registration list for lowlight: every language id
 * detection can produce, never Markdown.
 */
export const COMMON_LANGUAGES: readonly string[] = Array.from(
  new Set(Object.values(EXTENSION_LANGUAGE_MAP))
).sort();
