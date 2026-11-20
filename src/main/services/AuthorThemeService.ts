import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { AppSettings, AuthorThemeSummary, WallpaperId } from "../../shared/contracts";
import type { SettingsStore } from "./SettingsStore";
import { MAX_WALLPAPER_PACKAGE_BYTES, validateWallpaperRecipe } from "../../shared/wallpaper.ts";
import type { WallpaperRegistry } from "./WallpaperRegistry";
import type { PixelSkinPackRegistry } from "./PixelSkinPackRegistry";

const THEMES = [
  { id: "living-forge", name: "Living Forge", skin: "pixel:92020000-0000-4000-8000-000000000004", font: "mono" },
  { id: "kisa-nocturne", name: "Kisa’s Theme", skin: "pixel:92020000-0000-4000-8000-000000000005", font: "mono" },
  { id: "teo-kurohane", name: "Teo’s Theme", skin: "pixel:92020000-0000-4000-8000-000000000006", font: "serif" },
  { id: "steampunk-airship", name: "Steampunk Airship", skin: "pixel:92020000-0000-4000-8000-000000000007", font: "serif" },
  { id: "brutalist-monolith", name: "Brutalist Monolith", skin: "pixel:92020000-0000-4000-8000-000000000008", font: "mono" },
  { id: "cyberpunk-noodle-bar", name: "Cyberpunk Noodle Bar", skin: "pixel:92020000-0000-4000-8000-000000000009", font: "mono" }
] as const;
// Appearance only: never copy a manifest's timers, canvas objects, shortcuts or permissions.
const APPEARANCE_KEYS = ["palette", "appSkin", "canvasColor", "pattern", "canvasBackgroundFit", "canvasBackgroundPaused", "terminalBackground", "terminalSkinDetail", "homeClockFont", "homeAccentPreset", "homeAccentColors"] as const;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class AuthorThemeService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly root: string;
  private readonly settings: Pick<SettingsStore, "update">;
  private readonly skins: Pick<PixelSkinPackRegistry, "list">;
  private readonly wallpapers: Pick<WallpaperRegistry, "list" | "read" | "importPackage" | "remove">;

  constructor(
    root: string,
    settings: AuthorThemeService["settings"],
    skins: AuthorThemeService["skins"],
    wallpapers: AuthorThemeService["wallpapers"]
  ) {
    this.root = root;
    this.settings = settings;
    this.skins = skins;
    this.wallpapers = wallpapers;
  }

  private folder(id: string): string { return join(this.root, `${id}-profile`); }
  async list(): Promise<AuthorThemeSummary[]> {
    return Promise.all(THEMES.map(async ({ id, name }) => {
      let preview: string | undefined;
      try {
        const file = join(this.folder(id), "preview.png");
        if ((await stat(file)).size <= 512 * 1024) preview = `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
      } catch { /* A missing thumbnail does not prevent applying a complete theme. */ }
      return { id, name, preview };
    }));
  }

  apply(id: unknown): Promise<AppSettings> {
    const run = this.queue.then(() => this.applyOne(id));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyOne(id: unknown): Promise<AppSettings> {
    const theme = THEMES.find(t => t.id === id);
    if (!theme) throw new Error("Unknown appearance preset.");
    const folder = this.folder(theme.id);
    const manifest = JSON.parse((await readFile(join(folder, "preset.json"))).toString("utf8"));
    if (manifest.schemaVersion !== 1 || manifest.kind !== "canvastty-appearance-preset" || manifest.terminals?.id !== theme.skin) throw new Error("Invalid appearance preset manifest.");
    const verified = async (entry: { file: string; sha256: string }) => {
      if (!entry || typeof entry.file !== "string" || basename(entry.file) !== entry.file || entry.file.includes("\\") || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid theme asset.");
      const file = join(folder, entry.file);
      if ((await stat(file)).size > MAX_WALLPAPER_PACKAGE_BYTES) throw new Error("Theme asset is too large.");
      const bytes = await readFile(file);
      if (hash(bytes) !== entry.sha256) throw new Error(`Theme asset checksum mismatch: ${entry.file}`);
      return bytes;
    };
    if (!this.skins.list().some(skin => skin.id === theme.skin)) throw new Error("Bundled terminal theme is unavailable.");
    // The terminal catalog has already validated the frame ZIP. Check the wallpaper packages before changing the profile.
    const packages = await Promise.all(["canvas", "avatar", "clock"].map(slot => verified(manifest.wallpapers?.[slot])));
    const created: WallpaperId[] = [];
    try {
      const ids: WallpaperId[] = [];
      for (const bytes of packages) {
        const data = JSON.parse(bytes.toString("utf8"));
        const mediaHash = hash(Buffer.from(data.source?.base64 ?? "", "base64"));
        const recipe = JSON.stringify(validateWallpaperRecipe(data.recipe));
        let existing: WallpaperId | undefined;
        for (const candidate of this.wallpapers.list().filter(w => w.name === data.name && JSON.stringify(w.recipe) === recipe)) {
          const asset = await this.wallpapers.read(candidate.id);
          if (asset && hash(asset.bytes) === mediaHash) { existing = candidate.id; break; }
        }
        if (existing) ids.push(existing);
        else { const item = await this.wallpapers.importPackage(bytes); ids.push(item.id); created.push(item.id); }
      }
      const patch: Partial<AppSettings> = {};
      for (const key of APPEARANCE_KEYS) if (Object.hasOwn(manifest.settings ?? {}, key)) Object.assign(patch, { [key]: manifest.settings[key] });
      return await this.settings.update({ ...patch, appearanceFont: theme.font, homeClockDesign: "new", terminalBorderSkin: theme.skin,
        terminalSkinAnimationEnabled: true, canvasBackground: ids[0], homeAvatarWallpaper: ids[1], homeClockWallpaper: ids[2] });
    } catch (error) {
      await Promise.allSettled(created.map(asset => this.wallpapers.remove(asset)));
      throw error;
    }
  }
}
