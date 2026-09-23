import { createPrivateKey, createPublicKey } from "node:crypto";

const seed = Buffer.from(process.env.SPARKLE_EDDSA_PRIVATE_KEY ?? "", "base64");
const expected = Buffer.from(process.env.SPARKLE_PUBLIC_ED_KEY ?? "", "base64");
if (seed.length !== 32 || expected.length !== 32) {
  throw new Error("Sparkle owner key pair is missing or invalid");
}
const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
const key = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
const actual = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
if (!actual.equals(expected)) throw new Error("Sparkle signing key does not match packaged public key");
console.log("Sparkle key pair matches");
