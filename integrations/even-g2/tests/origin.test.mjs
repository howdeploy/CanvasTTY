import test from "node:test";
import assert from "node:assert/strict";
import { buildOrigin } from "../scripts/origin.mjs";

test("production packaging requires an exact HTTPS origin without credentials", () => {
  assert.equal(
    buildOrigin("https://bridge.example.test/"),
    "https://bridge.example.test",
  );
  for (const value of [
    "",
    "http://example.test",
    "https://*.example.test",
    "https://a:b@example.test",
    "https://example.test/api",
    "https://example.test?token=private",
    "https://example.test#private",
  ]) {
    assert.throws(() => buildOrigin(value));
  }
});

test("local HTTP is an explicit test option and never permits a public cleartext origin", () => {
  assert.throws(() => buildOrigin("http://127.0.0.1:3480"));
  assert.equal(
    buildOrigin("http://127.0.0.1:3480", { localDevelopment: true }),
    "http://127.0.0.1:3480",
  );
  assert.throws(() =>
    buildOrigin("http://public.example.test", { localDevelopment: true }),
  );
  assert.throws(() =>
    buildOrigin("http://127.attacker.test", { localDevelopment: true }),
  );
  assert.throws(() =>
    buildOrigin("http://192.168.attacker.test", { localDevelopment: true }),
  );
});
