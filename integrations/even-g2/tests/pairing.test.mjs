import test from "node:test";
import assert from "node:assert/strict";
import { pairComputer } from "../src/connect.mjs";
import { validatePairing } from "../src/pairing.mjs";
const token = "a".repeat(64),
  home = { sessions: [] };
const response = (data) => ({ ok: true, json: async () => data });
test("code exchange waits for Mac approval and does not put credentials in the URL", async () => {
  const paths = [],
    events = [];
  const result = await pairComputer("http://localhost:3481", "123456", {
    onPending: () => events.push("pending"),
    fetcher: async (url, options) => {
      paths.push(url);
      assert.equal(url.includes(token), false);
      if (url.endsWith("/pair")) {
        assert.deepEqual(JSON.parse(options.body), {
          code: "123456",
          name: "Even App",
        });
        assert.equal(options.headers.Authorization, undefined);
        return response({ token });
      }
      assert.equal(options.headers.Authorization, "Bearer " + token);
      return response(
        url.endsWith("/pair-status") ? { state: "approved" } : home,
      );
    },
  });
  assert.deepEqual(result, { token, home });
  assert.deepEqual(events, ["pending"]);
  assert.equal(paths.length, 3);
});
test("rejection and cancellation never fetch shared session content", async () => {
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(
    pairComputer("", "123456", {
      onPending: () => abort.abort(),
      signal: abort.signal,
      fetcher: async () => {
        calls++;
        return response({ token });
      },
    }),
    /отменено/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    pairComputer("", "123456", {
      fetcher: async (url) =>
        response(url.endsWith("/pair") ? { token } : { state: "rejected" }),
    }),
    /отклонено/,
  );
});
test("only an approved valid token is persisted; failure preserves the prior connection", async () => {
  const saved = [];
  let probed = "";
  assert.deepEqual(
    await validatePairing("123456", {
      probe: async (code) => {
        probed = code;
        return { token, home };
      },
      persist: async (value) => {
        saved.push(value);
        return true;
      },
    }),
    { token, home },
  );
  assert.equal(probed, "123456");
  assert.deepEqual(saved, [token]);
  await assert.rejects(
    validatePairing("123456", {
      probe: async () => ({ token: "z".repeat(64), home }),
      persist: async (value) => {
        saved.push(value);
        return true;
      },
    }),
  );
  assert.equal(saved.length, 1);
  await assert.rejects(
    validatePairing("123456", {
      probe: async () => ({ token, home }),
      persist: async () => false,
    }),
    /сохранить/,
  );
});

test("six-digit validation rejects old long tokens and overlong PINs before network calls", async () => {
  for (const code of ["12345", "1234567", "12345678", "CT-EXAMPLE-CODE", "123 456", "12e456"]) {
    await assert.rejects(validatePairing(code, { probe: () => { throw Error("network called"); } }), /шестизначный/);
  }
});
