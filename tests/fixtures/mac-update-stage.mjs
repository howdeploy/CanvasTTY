import { MacSparkleUpdater } from "../../src/main/services/updates/MacSparkleUpdater.ts";

const [directory, mode] = process.argv.slice(2);
const prefix = "https://github.com/howdeploy/CanvasTTY/releases/download/v1.6.0/";
const archive = Buffer.from("cached update archive");
globalThis.fetch = async input => {
  const url = String(input);
  if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({
    tag_name: "v1.6.0", body: "notes", draft: false, prerelease: false,
    assets: [
      { name: "CanvasTTY-1.6.0-mac-arm64.zip", browser_download_url: prefix + "CanvasTTY-1.6.0-mac-arm64.zip", size: archive.length },
      { name: "appcast.xml", browser_download_url: prefix + "appcast.xml", size: 7 }
    ]
  }), { status: 200 });
  if (url.endsWith("appcast.xml")) return new Response("<rss />", { status: 200 });
  if (url.endsWith(".zip")) return new Response(archive, { status: 200 });
  throw new Error("Unexpected fetch: " + url);
};
const updater = new MacSparkleUpdater(directory, "unused.app", "unused-helper", "unused-server", "1.5.2");
updater.probeSignedFeed = async () => true;
await updater.check();
await updater.download(() => {});
process.stdout.write("READY\n");
if (mode === "crash") process.kill(process.pid, "SIGKILL");
