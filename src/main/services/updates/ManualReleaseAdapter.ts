import type { AvailableUpdate, UpdateAdapter } from "./UpdateController.ts";

interface GithubRelease { tag_name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown }

export class ManualReleaseAdapter implements UpdateAdapter {
  async check(): Promise<AvailableUpdate | null> {
    const response = await fetch("https://api.github.com/repos/howdeploy/CanvasTTY/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "CanvasTTY-updater" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Release check failed (${response.status})`);
    const release = await response.json() as GithubRelease;
    if (release.draft || release.prerelease || typeof release.tag_name !== "string" ||
      !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) return null;
    const version = release.tag_name.slice(1);
    return { version, notes: typeof release.body === "string" ? release.body.slice(0, 10000) : undefined,
      manualUrl: "https://github.com/howdeploy/CanvasTTY/releases/tag/" + encodeURIComponent(release.tag_name) };
  }
  async download(): Promise<void> { throw new Error("This package is updated from GitHub Releases"); }
  async install(): Promise<void> { throw new Error("This package is updated from GitHub Releases"); }
}
