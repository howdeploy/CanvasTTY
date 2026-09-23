import type { DataClass } from './contracts.ts';
import type { ContextRule, ContextValue } from './contextProfiles.ts';

export type ConventionRule =
  | { kind: 'forbidden-colors'; colors: string[] }
  | { kind: 'forbidden-pair'; foreground: string; background: string }
  | { kind: 'formatter-config'; file: string; required: Record<string, string | number | boolean> }
  | { kind: 'filename'; extension: 'ts' | 'tsx' | 'js' | 'jsx' | 'css'; style: 'kebab-case' | 'camelCase' | 'PascalCase' }
  | { kind: 'dependencies'; section: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'; allow?: string[]; deny?: string[] };
export interface ConventionFinding { ruleId: string; key: string; source: ContextRule['source']; path: string; line: number; message: string }
export interface ConventionDiagnostic { code: string; message: string; path?: string; ruleId?: string; key?: string; source?: ContextRule['source'] }
export interface ConventionCoverage { path: string; changedLines: number; checks: number }
export interface ConventionReport {
  id: string; capsuleId: string; reviewId: string; state: 'disabled' | 'complete'; createdAt: number;
  reviewDigest?: string; contextDigest?: string; maxDataClass: DataClass;
  warnings: ConventionFinding[]; diagnostics: ConventionDiagnostic[]; coverage: ConventionCoverage[]; truncated: boolean;
}
const color = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(v);
export function parseConventionRule(value: ContextValue): ConventionRule | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const fields = (keys: string[]): boolean => Object.keys(value).every(k => keys.includes(k));
  const list = (v: unknown, valid: (s: unknown) => boolean): boolean => Array.isArray(v) && v.length > 0 && v.length <= 32 && v.every(valid);
  if (value.kind === 'forbidden-colors' && fields(['kind', 'colors']) && list(value.colors, color)) return value as ConventionRule;
  if (value.kind === 'forbidden-pair' && fields(['kind', 'foreground', 'background']) && color(value.foreground) && color(value.background)) return value as ConventionRule;
  if (value.kind === 'filename' && fields(['kind', 'extension', 'style']) && ['ts', 'tsx', 'js', 'jsx', 'css'].includes(String(value.extension)) && ['kebab-case', 'camelCase', 'PascalCase'].includes(String(value.style))) return value as ConventionRule;
  if (value.kind === 'formatter-config' && fields(['kind', 'file', 'required']) && typeof value.file === 'string' && /^(?:\.prettierrc(?:\.(?:json|ya?ml))?|\.eslintrc\.(?:json|ya?ml))$/u.test(value.file) && value.required && typeof value.required === 'object' && !Array.isArray(value.required) && Object.keys(value.required).length > 0 && Object.keys(value.required).length <= 16 && Object.entries(value.required).every(([k,v]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(k) && (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length <= 120))) return value as ConventionRule;
  const dependency = (v: unknown): boolean => typeof v === 'string' && /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/u.test(v);
  if (value.kind === 'dependencies' && fields(['kind', 'section', 'allow', 'deny']) && ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(String(value.section)) && (value.allow !== undefined || value.deny !== undefined) && (value.allow === undefined || list(value.allow, dependency)) && (value.deny === undefined || list(value.deny, dependency))) return value as ConventionRule;
  return;
}
export const CONVENTION_PRESETS: { label: string; ru: string; key: string; category: ContextRule['category']; value: ConventionRule }[] = [
  { label: 'Forbidden color', ru: 'Запрещённый цвет', key: 'validate.colors', category: 'design', value: { kind: 'forbidden-colors', colors: ['#000000'] } },
  { label: 'Forbidden color pair', ru: 'Пара цветов', key: 'validate.pair', category: 'design', value: { kind: 'forbidden-pair', foreground: '#000000', background: '#ffffff' } },
  { label: 'Formatter configuration', ru: 'Настройки форматтера', key: 'validate.formatter', category: 'code-style', value: { kind: 'formatter-config', file: '.prettierrc.json', required: { semi: true } } },
  { label: 'Filenames', ru: 'Имена файлов', key: 'validate.filenames', category: 'naming', value: { kind: 'filename', extension: 'tsx', style: 'PascalCase' } },
  { label: 'Dependencies', ru: 'Зависимости', key: 'validate.dependencies', category: 'dependencies', value: { kind: 'dependencies', section: 'dependencies', deny: ['example-package'] } }
];
