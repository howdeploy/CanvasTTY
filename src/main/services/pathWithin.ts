import { isAbsolute, relative, sep } from 'node:path';

/** Lexical containment including the root itself; callers establish canonical identity separately. */
export function pathWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
