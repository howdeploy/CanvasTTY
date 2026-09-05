export function directoryPathFromClipboard(text: string): string | null {
  // Select a path, skipping URI-list comments and file-manager metadata.
  const paths = text.split(/\r\n|[\r\n]/).map((line) => {
    let path = line.trim();
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
      path = path.slice(1, -1).trim();
    }
    return path;
  });
  let path = paths.find((line) => /^(?:\/|file:\/\/|[a-z]:[\\/]|\\\\|~\/)/i.test(line));
  if (!path) return null;

  if (path.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(path);
      const decodedPath = decodeURIComponent(url.pathname);
      path = url.hostname ? `//${url.hostname}${decodedPath}` : decodedPath;
      if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }

  return path || null;
}
