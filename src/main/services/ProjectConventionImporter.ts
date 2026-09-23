import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathWithin as within } from './pathWithin.ts';
import { isMap, parseDocument } from 'yaml';
import { dataClassForPath, DATA_CLASSES, type DataClass, type PathPolicy } from '../../shared/contracts.ts';
import { assertContextImports, assertContextRule, contextBytes, contextText, type ContextImport, type ContextImportDiagnostic, type ContextProject, type ContextRule, type ContextValue } from '../../shared/contextProfiles.ts';

const MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 256 * 1024;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function contextRootIdentity(path: string): string {
  const s = lstatSync(path);
  if (!s.isDirectory() || realpathSync(path) !== path || process.getuid && s.uid !== process.getuid()) throw new Error('Context project root must be a canonical owned directory.');
  return `${s.dev}:${s.ino}:${s.uid}`;
}
interface Source { text?: string; hash: string; bytes: number }
/** Synchronous because launch capture and its pre-disclosure guard are synchronous. No cache or watchers. */
function readSource(project: ContextProject, entry: ContextImport, projects: readonly ContextProject[]): Source {
  const rootIdentity = contextRootIdentity(project.root);
  if (!project.rootIdentity || rootIdentity !== project.rootIdentity) throw new Error('Context project root identity changed; select and save its directory again.');
  const target = join(project.root, entry.path);
  if (projects.some(p => p.id !== project.id && p.root.length > project.root.length && within(project.root, p.root) && within(p.root, target))) throw new Error('Context import crosses a separately registered nested project.');
  const rootStat = lstatSync(project.root), components = entry.path.split('/'), parents: Array<{ path: string; identity: string }> = [];
  let parent = project.root;
  try {
    for (const component of components.slice(0, -1)) {
      parent = join(parent, component); const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== rootStat.dev || s.uid !== rootStat.uid || realpathSync(parent) !== parent) throw new Error('Unsafe context import directory.');
      parents.push({ path: parent, identity: `${s.dev}:${s.ino}` });
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.dev !== rootStat.dev || before.uid !== rootStat.uid || before.size > MAX_FILE_BYTES) throw new Error('Unsafe or over-limit context import file.');
      const data = Buffer.alloc(before.size + 1); let length = 0;
      while (length < data.length) { const count = readSync(fd, data, length, data.length - length, length); if (!count) break; length += count; }
      const after = fstatSync(fd), current = lstatSync(target);
      if (length !== before.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || after.nlink !== 1 || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino || current.ctimeMs !== after.ctimeMs || realpathSync(target) !== target || contextRootIdentity(project.root) !== rootIdentity || parents.some(p => { const s = lstatSync(p.path); return !s.isDirectory() || `${s.dev}:${s.ino}` !== p.identity || realpathSync(p.path) !== p.path; })) throw new Error('Context import changed during reading.');
      const bytes = data.subarray(0, length), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      contextText(text, MAX_FILE_BYTES, 'import text', true);
      return { text, hash: hash(bytes), bytes: length };
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hash: 'missing', bytes: 0 };
    throw new Error('Unable to safely read context import. Check its selected file, UTF-8, size, ownership and links.', { cause: error });
  }
}
export interface ConventionCapture { rules: ContextRule[]; diagnostics: ContextImportDiagnostic[]; digest: string; assertCurrent(): void }
export function captureProjectConventions(project: ContextProject | undefined, projects: readonly ContextProject[], policies: readonly PathPolicy[], availableRules: number): ConventionCapture {
  const rules: ContextRule[] = [], diagnostics: ContextImportDiagnostic[] = [];
  if (!project?.importsEnabled || !project.imports?.length) return { rules, diagnostics, digest: hash('off'), assertCurrent() {} };
  assertContextImports(project);
  const revisions: Array<{ entry: ContextImport; hash: string }> = []; let bytes = 0;
  for (const entry of project.imports) {
    const source = readSource(project, entry, projects); bytes += source.bytes;
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Context imports exceed their aggregate byte bound.');
    revisions.push({ entry, hash: source.hash });
    const fileClass = dataClassForPath(policies, join(project.root, entry.path), 'D2', project.root);
    const dataClass = DATA_CLASSES[Math.max(DATA_CLASSES.indexOf(fileClass), DATA_CLASSES.indexOf(entry.dataClass ?? fileClass))]!;
    const diagnostic = (status: ContextImportDiagnostic['status'], message: string): void => { diagnostics.push({ sourcePath: entry.path, dataClass, status, message }); };
    if (source.text === undefined) { diagnostic('missing', 'Selected source is missing; no imported content is retained.'); continue; }
    const text = source.text;
    const add = (key: string, value: ContextValue, sourceLine: number, category: ContextRule['category']): void => {
      if (rules.length >= availableRules) throw new Error('Context imported projection exceeds the aggregate rule bound (2000, reserving 48 current rules).');
      const rule: ContextRule = { id: `import-${hash(`${project.id}:${entry.path}:${key}:${rules.length}`).slice(0, 48)}`, scope: 'project', ownerId: project.id, category, key, value, tags: [], dataClass, source: 'imported', confidence: 1, enabled: true, updatedAt: rules.length, provenance: { sourcePath: entry.path, sourceHash: source.hash, sourceLine } };
      assertContextRule(rule); rules.push(rule);
    };
    if (entry.kind === 'css') {
      const parsed = cssTokens(text, entry.selectors ?? [':root']);
      for (const token of parsed.tokens) add(`design.css.${token.selector === ':root' ? '' : `theme.${token.selector}.`}${token.name}`, token.value, token.line, 'design');
      if (parsed.unsupported) diagnostic('unsupported', 'Only literal declarations in selected top-level theme blocks are imported. Nested, computed or escaped CSS is not resolved.');
    } else if (entry.kind === 'config') {
      if (/\.(?:[cm]?js|ts)$/u.test(entry.path)) { diagnostic('reference', 'Executable configuration is reference-only; JavaScript and TypeScript are never evaluated or projected.'); continue; }
      const doc = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, schema: 'core', resolveKnownTags: false, merge: false, prettyErrors: false });
      if (doc.errors.length || doc.warnings.length) throw new Error('Invalid static YAML/JSON context configuration.');
      let config: unknown;
      try { config = doc.toJS({ maxAliasCount: 0 }); } catch { throw new Error('Aliases are unsupported in context configuration imports.'); }
      if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length > 64) throw new Error('Context configuration must be a bounded property mapping.');
      // Validate the entire value first, including dangerous keys and depth, before selecting any property.
      assertContextRule({ id: 'config-validation', scope: 'user', category: 'code-style', key: 'config', value: config, tags: [], dataClass, source: 'explicit', confidence: 1, enabled: true, updatedAt: 0 });
      for (const [key, value] of Object.entries(config)) {
        const node = isMap(doc.contents) ? doc.contents.items.find(item => String(item.key) === key)?.key : undefined;
        const start = node && typeof node === 'object' && 'range' in node && Array.isArray(node.range) ? node.range[0] as number : 0;
        const line = text.slice(0, start).split('\n').length;
        add(`code-style.${/prettier/u.test(entry.path) ? 'prettier' : 'eslint'}.${key}`, value as ContextValue, Math.max(1, line), 'code-style');
      }
    } else if (entry.kind === 'editorconfig') {
      let section = '*';
      for (const [index, raw] of text.split('\n').entries()) {
        const line = raw.trim(); if (!line || /^[#;]/u.test(line)) continue;
        if (/^\[[^\]\x00-\x1f]+\]$/u.test(line)) { section = line.slice(1, -1); continue; }
        const property = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u.exec(line);
        if (!property) throw new Error('Unsupported editorconfig import syntax.');
        add(`code-style.editorconfig.${hash(section).slice(0, 12)}.${property[1]}`, { section, setting: property[1]!, value: property[2]! }, index + 1, 'code-style');
      }
    } else {
      let lines = text.split('\n').map((value, index) => ({ value, line: index + 1 }));
      if (entry.path.endsWith('.mdc') && lines[0]?.value.trim() === '---') {
        const end = lines.findIndex((l, i) => i > 0 && l.value.trim() === '---');
        const front = end > 0 ? lines.slice(1, end).map(l => l.value).join('\n') : '';
        // Scoped/unknown frontmatter cannot silently widen into every task.
        if (!alwaysAppliedCursorFrontmatter(front)) { diagnostic('unsupported', 'Cursor rules require alwaysApply: true and optional plain description. Scoped globs and unknown frontmatter are not projected.'); continue; }
        lines = lines.slice(end + 1);
      }
      if (entry.kind === 'readme') {
        let selectedLevel = 0, fence = '';
        lines = lines.filter(l => {
          const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(l.value)?.[1];
          if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(l.value)) fence = ''; return !!selectedLevel; }
          if (fence) return !!selectedLevel;
          const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(l.value);
          if (heading) { if (selectedLevel && heading[1]!.length <= selectedLevel) selectedLevel = 0; if (/\b(develop(?:ment|er)?|contribut(?:ing|ion)|testing|code style)\b|разработ|тестирован|стиль кода/iu.test(heading[2]!)) selectedLevel = heading[1]!.length; }
          return !!selectedLevel;
        });
      }
      const chunks: Array<{ value: string; line: number }> = [];
      for (const line of lines) {
        let part = '', partBytes = 0;
        for (const c of line.value + '\n') {
          const bytes = contextBytes(c);
          if (partBytes + bytes > 1800) { chunks.push({ value: part, line: line.line }); part = ''; partBytes = 0; }
          part += c; partBytes += bytes;
        }
        if (part) { const last = chunks.at(-1); if (last && contextBytes(last.value + part) <= 1800) last.value += part; else chunks.push({ value: part, line: line.line }); }
      }
      for (const [index, chunk] of chunks.entries()) if (chunk.value.trim()) add(`convention.${entry.kind}.${hash(entry.path).slice(0, 12)}.${index + 1}`, chunk.value.trim(), chunk.line, /CONTRIBUTING|README/iu.test(entry.path) ? 'documentation' : 'architecture');
    }
  }
  const digest = hash(JSON.stringify(revisions));
  return { rules, diagnostics, digest, assertCurrent() {
    for (const revision of revisions) {
      try { if (readSource(project, revision.entry, projects).hash !== revision.hash) throw new Error('changed'); }
      catch { throw new Error('Context import source changed before launch. Rebuild the preview or launch.'); }
    }
  } };
}

/** Parse only the two supported literal fields, with no ambiguous repeated regex groups. */
function alwaysAppliedCursorFrontmatter(front: string): boolean {
  const keys = new Set<string>();
  for (const raw of front.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return false;
    const key = line.slice(0, colon);
    if (keys.has(key) || key !== 'alwaysApply' && key !== 'description') return false;
    if (key === 'alwaysApply' && line.slice(colon + 1).trim() !== 'true') return false;
    keys.add(key);
  }
  return keys.has('alwaysApply');
}

/** Deliberately static: top-level selected blocks only; strings/comments do not create fake declarations. */
function cssTokens(text: string, selectors: string[]): { tokens: Array<{ name: string; value: string; line: number; selector: string }>; unsupported: boolean } {
  const tokens: Array<{ name: string; value: string; line: number; selector: string }> = []; let unsupported = false;
  let clean = '', quote = '', comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (comment) { if (c === '*' && text[i + 1] === '/') { clean += '  '; i++; comment = false; } else clean += c === '\n' ? '\n' : ' '; continue; }
    if (quote) { clean += c; if (c === '\\') { clean += text[++i] ?? ''; } else if (c === quote) quote = ''; continue; }
    if (c === '/' && text[i + 1] === '*') { clean += '  '; i++; comment = true; }
    else { clean += c; if (c === '"' || c === "'") quote = c; }
  }
  if (comment || quote) throw new Error('Invalid static CSS import.');
  let start = 0, bodyStart = 0, depth = 0, selector = ''; quote = '';
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (depth++ === 0) { selector = clean.slice(start, i).trim(); bodyStart = i + 1; } else unsupported = true; }
    else if (c === '}') {
      if (--depth < 0) throw new Error('Invalid static CSS import.');
      if (!depth) {
        const body = clean.slice(bodyStart, i);
        if (selectors.includes(selector) && !/[{}\\]/u.test(body)) {
          let declaration = 0, parentheses = 0; quote = '';
          for (let j = 0; j <= body.length; j++) {
            const char = body[j];
            if (quote) { if (char === quote) quote = ''; continue; }
            if (char === '"' || char === "'") { quote = char; continue; }
            if (char === '(') parentheses++; if (char === ')') parentheses--;
            if (j === body.length || char === ';' && !parentheses) {
              const part = body.slice(declaration, j), match = /^\s*(--[A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+?)\s*$/u.exec(part);
              if (match) tokens.push({ name: match[1]!, value: match[2]!, selector, line: clean.slice(0, bodyStart + declaration + part.indexOf(match[1]!)).split('\n').length });
              else if (part.includes('--')) unsupported = true;
              declaration = j + 1;
            }
          }
          if (parentheses || quote) throw new Error('Invalid static CSS declaration.');
        } else if (selector.startsWith('@') || selectors.includes(selector)) unsupported = true;
        start = i + 1;
      }
    } else if (c === ';' && !depth) start = i + 1;
  }
  if (depth) throw new Error('Invalid static CSS import.');
  return { tokens, unsupported };
}
