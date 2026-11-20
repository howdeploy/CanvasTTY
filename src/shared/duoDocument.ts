import type { AppSettings, BrowserSnapshot, InstalledPlugin, MaterialsSnapshot } from './contracts';

/** Workspace data only. Camera, focus, OS shortcuts, accounts and credentials stay local. */
export const DUO_SETTINGS_KEYS = [
  'canvasRegions','stickyNotes','fileCards','pluginCanvas','browserCanvas',
  'homeLayout','homeGridSize','homeTime','homeAvatarWallpaper','homeClockWallpaper','homeClockFont','homeClockDesign',
  'canvasBackground','canvasBackgroundPaused','canvasBackgroundFit','canvasColor','pattern',
  'mediaPath','mediaFit','homeAccentPreset','homeAccentColors',
  'terminalBorderSkin','terminalBackground','terminalBackgroundBrightness','terminalBackgroundContrast',
  'terminalBackgroundSaturation','terminalBackgroundPaused','terminalBackgroundSpeed','terminalBackgroundScale',
  'terminalBackgroundOffsetX','terminalBackgroundOffsetY','terminalBackgroundReadability',
  'terminalBackgroundReadabilityStrength','terminalBackgroundOverrides','terminalSkinDetail','terminalSkinAnimationEnabled'
] as const satisfies readonly (keyof AppSettings)[];
export type DuoSettings = Pick<AppSettings, typeof DUO_SETTINGS_KEYS[number]>;
export interface DuoDocument { settings: DuoSettings; materials: MaterialsSnapshot; plugins: InstalledPlugin[]; browser: BrowserSnapshot; storageEvents?: Array<{pluginId:string;key:string;value:unknown;version:number}> }
export interface DuoDocumentOp { key: keyof DuoSettings; id?: string; before: unknown; after: unknown; fields?: string[] }
const collections = new Set(['canvasRegions','stickyNotes','fileCards','pluginCanvas']);
const equal = (a: unknown,b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function pickDuoSettings(settings: AppSettings): DuoSettings {
  return Object.fromEntries(DUO_SETTINGS_KEYS.map(key=>[key,settings[key]])) as unknown as DuoSettings;
}
/** Array edits are per object and per field, so editing a note never replaces other notes. */
export function duoSettingsOps(base: DuoSettings, patch: Partial<AppSettings>): DuoDocumentOp[] {
  const ops: DuoDocumentOp[]=[];
  for (const key of DUO_SETTINGS_KEYS) {
    if (!(key in patch) || equal(base[key],patch[key])) continue;
    if (collections.has(key)) {
      const old = (base[key] ?? []) as unknown as Array<Record<string,unknown>>;
      const next = patch[key] as unknown as Array<Record<string,unknown>>;
      if (!Array.isArray(next)) throw Error('Invalid shared collection.');
      for (const id of new Set([...old,...next].map(item=>item.id))) {
        if (typeof id !== 'string') throw Error('Shared objects need an id.');
        const before=old.find(item=>item.id===id) ?? null,after=next.find(item=>item.id===id) ?? null;
        if (equal(before,after)) continue;
        const fields=before&&after ? [...new Set([...Object.keys(before),...Object.keys(after)])].filter(field=>field!=='id'&&!equal(before[field],after[field])) : undefined;
        ops.push({key,id,before,after,fields});
      }
    } else ops.push({key,before:base[key]??null,after:patch[key]??null});
  }
  return ops;
}
export function applyDuoSettingsOps(settings: AppSettings, ops: DuoDocumentOp[]): Partial<AppSettings> {
  if (!Array.isArray(ops)||ops.length>256||JSON.stringify(ops).length>48_000) throw Error('Invalid shared document edit.');
  const patch: Record<string,unknown>={};
  for (const op of ops) {
    if (!op || !DUO_SETTINGS_KEYS.includes(op.key) || ['__proto__','constructor','prototype'].includes(op.key)) throw Error('This setting is private to each participant.');
    const current=patch[op.key]??settings[op.key];
    if (collections.has(op.key)) {
      if (typeof op.id!=='string'||op.id.length>160||!Array.isArray(current)) throw Error('Invalid shared object.');
      const items=current as unknown as Array<Record<string,unknown>>,item=items.find(i=>i.id===op.id)??null;
      if (op.after===null) {
        if (!equal(item,op.before)) throw Error('Объект изменён другим участником. Повторите действие.');
        patch[op.key]=items.filter(i=>i.id!==op.id);
      } else if (op.before===null) {
        if (item || typeof op.after!=='object' || (op.after as any)?.id!==op.id) throw Error('Shared object already exists.');
        patch[op.key]=[...items,op.after];
      } else {
        if (!item||!op.before||!op.after||!Array.isArray(op.fields)||op.fields.length>32) throw Error('Shared object was removed.');
        const next={...item};
        for (const field of op.fields) {
          if (['id','__proto__','constructor','prototype'].includes(field)) throw Error('Invalid shared object field.');
          if (!equal(item[field],(op.before as any)[field])&&!equal(item[field],(op.after as any)[field])) throw Error('Поле изменено другим участником. Повторите действие.');
          next[field]=(op.after as any)[field];
        }
        patch[op.key]=items.map(i=>i.id===op.id?next:i);
      }
    } else {
      if (!equal(current??null,op.before)&&!equal(current??null,op.after)) throw Error('Настройка изменена другим участником. Повторите действие.');
      patch[op.key]=op.after;
    }
  }
  return patch as Partial<AppSettings>;
}
export interface DuoDocumentPort {
  snapshot(): Promise<DuoDocument>;
  edit(ops: DuoDocumentOp[], authorized:()=>boolean): Promise<void>;
  resource(channel:string,args:unknown[],authorized:()=>boolean,manage:boolean,connected?:()=>boolean): Promise<unknown>;
  revokeControl?():void;
  clear():void;
}
