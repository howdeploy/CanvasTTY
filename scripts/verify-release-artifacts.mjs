import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import YAML from "yaml";

const [tag, directory = "release-artifacts"] = process.argv.slice(2);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "") || tag.slice(1) !== manifest.version) {
  throw new Error(`Release tag must equal package version v${manifest.version} and be stable`);
}
const names = await readdir(resolve(directory));
const version = manifest.version.replaceAll(".", "\\.");
const required = [
  new RegExp(`^CanvasTTY-${version}-mac-arm64\\.zip$`),
  new RegExp(`^CanvasTTY-${version}-mac-arm64\\.dmg$`),
  new RegExp(`^CanvasTTY-${version}-linux-x64\\.AppImage$`),
  new RegExp(`^CanvasTTY-${version}-linux-x64\\.deb$`),
  new RegExp(`^CanvasTTY-${version}-windows-x64-setup\\.exe$`),
  new RegExp(`^CanvasTTY-${version}-windows-x64-portable\\.exe$`),
  /^latest\.yml$/, /^latest-linux\.yml$/, /^appcast\.xml$/
];
for (const pattern of required) {
  const name = names.find(candidate => pattern.test(candidate));
  if (!name) throw new Error(`Missing release artifact: ${pattern}`);
  const file = await stat(join(directory, name));
  if (!file.isFile() || file.size === 0) throw new Error(`Empty or invalid release artifact: ${name}`);
}
const hashes = new Map();
async function artifactHash(name) {
  if (hashes.has(name)) return hashes.get(name);
  const digest = createHash("sha512");
  for await (const chunk of createReadStream(join(directory, name))) digest.update(chunk);
  const value = digest.digest("base64");
  hashes.set(name, value);
  return value;
}
for (const channel of ["latest.yml", "latest-linux.yml"]) {
  const info = YAML.parse(await readFile(join(directory, channel), "utf8"));
  if (info?.version !== manifest.version || !Array.isArray(info.files) || info.files.length === 0) {
    throw new Error(`Invalid ${channel}`);
  }
  for (const file of info.files) {
    if (typeof file.url !== "string" || !names.includes(file.url) ||
        !Number.isSafeInteger(file.size) || file.size <= 0 ||
        typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
      throw new Error(`${channel} references a missing or unsigned file`);
    }
    const actual = await stat(join(directory, file.url));
    if (!actual.isFile() || actual.size !== file.size || await artifactHash(file.url) !== file.sha512) {
      throw new Error(`${channel} references a changed file: ${file.url}`);
    }
  }
  const referenced = info.files.map(file => file.url);
  const extensions = channel === "latest.yml" ? ["-setup.exe"] : [".AppImage", ".deb"];
  for (const extension of extensions) {
    if (!referenced.some(name => name.endsWith(extension))) {
      throw new Error(`${channel} does not offer ${extension}`);
    }
  }
}
const appcast = await readFile(join(directory, "appcast.xml"), "utf8");
if (!appcast.includes(`<sparkle:version>${manifest.version}</sparkle:version>`) ||
    !appcast.includes(`CanvasTTY-${manifest.version}-mac-arm64.zip`) ||
    !appcast.includes("sparkle:edSignature=") || !appcast.includes("<!-- sparkle-signatures:")) {
  throw new Error("Mac appcast has no signed feed and archive entry for this version");
}
console.log(`Verified stable ${tag} release artifacts`);
