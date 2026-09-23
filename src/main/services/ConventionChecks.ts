import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { parseConventionRule, type ConventionCoverage, type ConventionDiagnostic, type ConventionFinding, type ConventionRule } from '../../shared/conventions.ts';
import type { ContextRule } from '../../shared/contextProfiles.ts';

type File = { path: string; before: Buffer; after?: Buffer };
function lineLookup(text: string): (offset: number) => number {
  const starts = [0]; for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return offset => { let lo = 0, hi = starts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid]! <= offset) lo = mid + 1; else hi = mid; } return lo; };
}
const textOf = (bytes: Buffer): string => { if (bytes.includes(0)) throw new Error('binary'); return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/gu, '\n'); };
/** LCS over trusted file bytes; patch-looking source and filenames cannot redirect coordinates. */
export function changedConventionLines(before: string, after: string, budget?: { cells: number; exhausted?: boolean }): Set<number> | undefined {
  const lines = (s: string): string[] => { const list = s.split('\n'); if (list.at(-1) === '') list.pop(); return list; };
  const a = lines(before), b = lines(after); if (a.length > 10000 || b.length > 10000) return;
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start; if ((n + 1) * (m + 1) > 1_000_000) return;
  const cells = (n + 1) * (m + 1);
  if (budget) { if (cells > budget.cells) { budget.exhausted = true; return; } budget.cells -= cells; }
  const width = m + 1, matrix = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) matrix[i * width + j] = a[start + i] === b[start + j] ? matrix[(i + 1) * width + j + 1]! + 1 : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!);
  const changed = new Set<number>(); let i = 0, j = 0;
  while (j < m) {
    if (i < n && a[start + i] === b[start + j]) { i++; j++; }
    else if (i < n && matrix[(i + 1) * width + j]! >= matrix[i * width + j + 1]!) i++;
    else { changed.add(start + j + 1); j++; }
  }
  return changed;
}
interface Declaration { property: string; value: string; line: number; valueLine: number; endLine: number }
function cssBlocks(text: string): { blocks: Declaration[][]; unsupported: boolean } {
  const lineAt = lineLookup(text);
  let clean = '', quote = '', comment = false, unsupported = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (comment) { if (c === '*' && text[i + 1] === '/') { clean += '  '; i++; comment = false; } else clean += c === '\n' ? '\n' : ' '; continue; }
    if (quote) { clean += c; if (c === '\\') clean += text[++i] ?? ''; else if (c === quote) quote = ''; continue; }
    if (c === '/' && text[i + 1] === '*') { comment = true; clean += '  '; i++; } else { clean += c; if (c === '"' || c === "'") quote = c; }
  }
  if (comment || quote) return { blocks: [], unsupported: true };
  const blocks: Declaration[][] = []; let depth = 0, start = 0, body = 0, nested = false, selector = ''; quote = '';
  const parseBlock = (from: number, to: number): Declaration[] => {
    const declarations: Declaration[] = []; let cursor = from, q = '';
    for (let i = from; i <= to; i++) {
      const c = clean[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c !== ';' && i !== to) continue;
      const raw = clean.slice(cursor, i), match = /^\s*([a-zA-Z-]+)\s*:\s*([^]*?)\s*$/u.exec(raw);
      if (match) declarations.push({ property: match[1]!.toLowerCase(), value: match[2]!.trim().toLowerCase(), line: lineAt(cursor + raw.search(/\S/u)), valueLine: lineAt(cursor + raw.indexOf(':') + 1 + Math.max(0, raw.slice(raw.indexOf(':') + 1).search(/\S/u))), endLine: lineAt(cursor + raw.trimEnd().length - 1) });
      else if (raw.trim()) unsupported = true;
      cursor = i + 1;
    }
    return declarations;
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!; if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (depth++ === 0) { selector = clean.slice(start, i).trim(); body = i + 1; nested = false; } else nested = true; }
    if (c === '}') {
      if (!depth) { unsupported = true; start = i + 1; continue; }
      if (--depth === 0) {
        if (nested || !/^(?::root|[.#]?[A-Za-z_][A-Za-z0-9_-]*)$/u.test(selector)) unsupported = true;
        else blocks.push(parseBlock(body, i));
        start = i + 1;
      }
    }
  }
  if (depth || clean.slice(start).trim()) unsupported = true;
  return { blocks, unsupported };
}
interface StaticRecord { value: unknown; line: number; endLine: number }
function staticMapping(text: string, json: boolean): { entries: Map<string, StaticRecord>; section(name: string): Map<string, StaticRecord> | undefined } {
  const lineAt = lineLookup(text);
  if (json) JSON.parse(text);
  const doc = parseDocument(text, { strict: true, uniqueKeys: true, stringKeys: true, schema: 'core', resolveKnownTags: false, merge: false, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error('Invalid mapping');
  const root = doc.contents;
  const pending: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++nodes > 2048 || depth > 4 || isAlias(node) || node && typeof node === 'object' && 'tag' in node && node.tag) throw new Error('Unsupported configuration structure');
    if (isMap(node)) { if (node.items.length > 64) throw new Error('Configuration mapping bound'); for (const pair of node.items) { if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.tag) throw new Error('Invalid mapping key'); pending.push({ node: pair.value, depth: depth + 1 }); } }
    if (isSeq(node)) { if (node.items.length > 64) throw new Error('Configuration sequence bound'); for (const item of node.items) pending.push({ node: item, depth: depth + 1 }); }
  }
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  const bounded = (v: unknown, depth = 0): void => {
    if (depth > 4 || v && typeof v === 'object' && Object.keys(v).length > 64) throw new Error('Unsupported config bound');
    if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) { if (['__proto__','constructor','prototype','<<'].includes(key)) throw new Error('Unsupported config key'); bounded(child, depth + 1); }
  };
  bounded(value);
  const entries = (map: typeof doc.contents): Map<string, StaticRecord> => {
    const result = new Map<string, StaticRecord>(); if (!isMap(map)) throw new Error('Unsupported mapping');
    for (const pair of map.items) { if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.tag) throw new Error('Unsupported mapping key'); result.set(pair.key.value, { value: pair.value?.toJSON(), line: lineAt(pair.key.range?.[0] ?? 0), endLine: lineAt(Math.max(pair.key.range?.[0] ?? 0, (pair.value?.range?.[1] ?? pair.key.range?.[1] ?? 1) - 1)) }); }
    return result;
  };
  return { entries: entries(root), section(name) { const pair = root.items.find(p => isScalar(p.key) && p.key.value === name); if (!pair) return; if (!isMap(pair.value)) throw new Error('Unsupported dependency section'); return entries(pair.value); } };
}
const colorProperties = new Set(['color', 'background', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke']);
export function checkConventions(files: readonly File[], rules: readonly ContextRule[]): { warnings: ConventionFinding[]; diagnostics: ConventionDiagnostic[]; coverage: ConventionCoverage[]; truncated: boolean } {
  const warnings: ConventionFinding[] = [], diagnostics: ConventionDiagnostic[] = [], coverage: ConventionCoverage[] = []; let truncated = false;
  const diagnostic = (d: ConventionDiagnostic): void => { if (diagnostics.length < 64) diagnostics.push(d); else truncated = true; };
  const compiled: { rule: ContextRule; check: ConventionRule }[] = [];
  for (const rule of rules) { if (!rule.key.startsWith('validate.')) continue; const check = parseConventionRule(rule.value); if (!check) diagnostic({ code: 'invalid-rule', ruleId: rule.id, key: rule.key, source: rule.source, message: 'Unsupported structured validator rule; no check performed.' }); else if (compiled.length < 64) compiled.push({ rule, check }); else truncated = true; }
  let totalBytes = 0, work = 0; const comparisonBudget = { cells: 4_000_000, exhausted: false };
  for (const file of files) {
    const diag = (code: string, message: string): void => diagnostic({ path: file.path, code, message });
    totalBytes += file.before.length + (file.after?.length ?? 0);
    if (totalBytes > 2 * 1024 * 1024 || work > 250000) { diag('work-bound', 'Aggregate validation bound reached; remaining coverage is omitted.'); truncated = true; break; }
    if (!file.after) { diag('deleted', 'Deleted file: content validation is unavailable.'); continue; }
    if (file.before.length > 262144 || file.after.length > 262144) { diag('file-bound', 'File exceeds 256 KiB validation bound.'); continue; }
    let before: string, after: string;
    try { before = textOf(file.before); after = textOf(file.after); } catch { diag('binary', 'Binary or non-UTF-8 file: no text checks.'); continue; }
    const changed = changedConventionLines(before, after, comparisonBudget); if (!changed) { diag('line-bound', comparisonBudget.exhausted ? 'Aggregate changed-line comparison bound reached; remaining coverage is omitted.' : 'Changed-line analysis exceeds its bounded comparison.'); if (comparisonBudget.exhausted) { truncated = true; break; } continue; }
    const item = { path: file.path, changedLines: changed.size, checks: 0 }; coverage.push(item);
    const changedIn = (d: { line: number; endLine: number }): number | undefined => { for (let line = d.line; line <= d.endLine; line++) if (changed.has(line)) return line; return; };
    const changedDeclaration = (d: Declaration): number | undefined => changed.has(d.line) ? d.line : changed.has(d.valueLine) ? d.valueLine : undefined;
    let css: ReturnType<typeof cssBlocks> | undefined;
    const mappings = new Map<string, ReturnType<typeof staticMapping> | Error>();
    const mapping = (which: 'before' | 'after', json: boolean): ReturnType<typeof staticMapping> => {
      const key = `${which}:${json}`; let result = mappings.get(key);
      if (!result) { try { result = staticMapping(which === 'before' ? before : after, json); } catch { result = new Error('Unsupported static config'); } mappings.set(key, result); }
      if (result instanceof Error) throw result; return result;
    };
    const warn = (rule: ContextRule, line: number, message: string): void => { if (warnings.length < 128) warnings.push({ ruleId: rule.id, key: rule.key, source: rule.source, path: file.path, line, message }); else truncated = true; };
    for (const { rule, check } of compiled) {
      if (check.kind === 'forbidden-colors' || check.kind === 'forbidden-pair') {
        if (!file.path.endsWith('.css') || !changed.size) continue;
        if (!css) { css = cssBlocks(after); if (css.blocks.some(block => block.some(d => changedDeclaration(d) !== undefined && colorProperties.has(d.property) && !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(d.value)))) diag('unsupported-css-value', 'Only complete #RRGGBB or #RRGGBBAA color literals are covered; computed values, shorthand and priorities are omitted.'); if (css.unsupported) diag('unsupported-css', 'Only simple top-level CSS blocks and literal declarations are covered; nested, at-rule or malformed syntax is omitted.'); }
        item.checks++;
        for (const block of css.blocks) {
          work += block.length; if (work > 250000) { truncated = true; break; }
          if (check.kind === 'forbidden-colors') {
            for (const d of block) if (changedDeclaration(d) !== undefined && colorProperties.has(d.property) && check.colors.some(c => c.toLowerCase() === d.value)) warn(rule, changedDeclaration(d)!, `Forbidden literal color ${d.value}.`);
          } else {
            const foreground = block.filter(d => d.property === 'color'), background = block.filter(d => d.property === 'background' || d.property === 'background-color');
            // Duplicate declarations imply cascade ordering, outside this check's vocabulary.
            if (foreground.length > 1 || background.length > 1) { diag('unsupported-css', 'Repeated foreground/background declarations require cascade evaluation and are omitted.'); continue; }
            const fg = foreground[0], bg = background[0];
            if (fg && bg && (changedDeclaration(fg) !== undefined || changedDeclaration(bg) !== undefined) && fg.value === check.foreground.toLowerCase() && bg.value === check.background.toLowerCase()) warn(rule, changedDeclaration(fg) ?? changedDeclaration(bg)!, 'Forbidden literal foreground/background pair in one simple block.');
          }
        }
      } else if (check.kind === 'filename') {
        if (!file.path.endsWith('.' + check.extension) || !changed.size) continue; item.checks++;
        const stem = file.path.split('/').at(-1)!.slice(0, -check.extension.length - 1), pattern = check.style === 'kebab-case' ? /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u : check.style === 'camelCase' ? /^[a-z][A-Za-z0-9]*$/u : /^[A-Z][A-Za-z0-9]*$/u;
        // Capsules select existing paths, so naming is advisory on edited files, never a newly-created-file claim.
        if (!pattern.test(stem)) diag('existing-filename', `Edited filename does not follow ${check.style}; existing names are advisory, not a new violation.`);
      } else if (check.kind === 'formatter-config') {
        if (file.path.split('/').at(-1) !== check.file) continue; item.checks++;
        try {
          const current = mapping('after', check.file.endsWith('.json')), old = mapping('before', check.file.endsWith('.json'));
          for (const [key, expected] of Object.entries(check.required)) { const next = current.entries.get(key), previous = old.entries.get(key); if (next?.value === expected || next?.value === previous?.value) continue; if (next && changedIn(next) !== undefined) warn(rule, changedIn(next)!, `Configuration ${key} must equal ${JSON.stringify(expected)}.`); else if (!next && previous?.value === expected) diag('removed-config', `Required configuration ${key} was removed; no after-line coordinate exists.`); }
        } catch { diag('unsupported-config', 'Malformed or unsupported static configuration; executable configs are never evaluated.'); }
      } else if (file.path.split('/').at(-1) === 'package.json') {
        item.checks++;
        try {
          const current = mapping('after', true).section(check.section), old = mapping('before', true).section(check.section);
          for (const [name, record] of current ?? []) {
            if (typeof record.value !== 'string' || record.value.length > 512) throw new Error('Unsupported dependency value');
            if (record.value === old?.get(name)?.value || changedIn(record) === undefined) continue;
            if (check.deny?.includes(name) || check.allow && !check.allow.includes(name)) warn(rule, changedIn(record)!, `Dependency ${name} is outside the ${check.section} constraint.`);
          }
        } catch { diag('unsupported-package', 'Malformed or unsupported bounded package dependency mapping; no resolution was performed.'); }
      }
    }
    if (/^(?:\.?prettier(?:rc|\.config)|\.?eslint(?:rc|\.config))(?:\.[cm]?js|\.ts)$/u.test(file.path.split('/').at(-1)!)) diag('executable-config', 'Executable configuration is a reference only and was not loaded or run.');
    if (!item.checks) diag('no-checks', 'No supported rule checks apply to added or changed lines in this file.');
  }
  return { warnings, diagnostics, coverage, truncated };
}
