const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const key = process.env.SPARKLE_PUBLIC_ED_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) {
    throw new Error("SPARKLE_PUBLIC_ED_KEY must be the owner's 32-byte Ed25519 public key in base64");
  }
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
  const set = (...args) => execFileSync("plutil", args.concat(plist));
  set("-insert", "SUPublicEDKey", "-string", key);
  set("-insert", "SUFeedURL", "-string", "https://github.com/howdeploy/CanvasTTY/releases/latest/download/appcast.xml");
  set("-insert", "SUEnableAutomaticChecks", "-bool", "NO");
  set("-insert", "SUAutomaticallyUpdate", "-bool", "NO");
  set("-insert", "SUVerifyUpdateBeforeExtraction", "-bool", "YES");
  set("-insert", "SURequireSignedFeed", "-bool", "YES");
  set("-insert", "SUSignedFeedFailureExpirationInterval", "-integer", "0");
};
