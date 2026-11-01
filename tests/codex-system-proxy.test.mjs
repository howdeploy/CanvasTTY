import assert from "node:assert/strict";
import test from "node:test";
import { codexRateLimitsNetworkUrl, codexSystemProxyEnvironment } from "../src/main/services/codexSystemProxy.ts";

const URL = "https://chatgpt.com/backend-api/wham/usage";

test("Chromium HTTP, HTTPS and SOCKS routes become CLI proxy URLs with remote SOCKS DNS", async () => {
  for (const [route, proxy] of [
    ["PROXY proxy.example:3128", "http://proxy.example:3128"],
    ["HTTPS proxy.example:443", "https://proxy.example:443"],
    ["SOCKS proxy.example:1080", "socks4a://proxy.example:1080"],
    ["SOCKS4 proxy.example:1080", "socks4a://proxy.example:1080"],
    ["SOCKS5 [::1]:1080; DIRECT", "socks5h://[::1]:1080"]
  ]) {
    assert.deepEqual(await codexSystemProxyEnvironment(URL, async () => route, {}), { HTTPS_PROXY: proxy });
  }
  assert.deepEqual(await codexSystemProxyEnvironment("http://backend.example/usage", async () => "PROXY proxy.example:3128", {}),
    { HTTP_PROXY: "http://proxy.example:3128" });
});

test("explicit CLI proxies take precedence without consulting the system resolver or changing the environment", async () => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const environment = Object.freeze({ [name]: "http://explicit.example:3128", NO_PROXY: "localhost" });
    assert.deepEqual(await codexSystemProxyEnvironment(URL, async () => { assert.fail("must not override explicit proxy"); }, environment), {});
  }
});

test("DIRECT, malformed, unsupported and credential-bearing routes never inject a proxy", async () => {
  for (const route of ["DIRECT", "DIRECT; SOCKS5 proxy.example:1080", "", "QUIC proxy.example:443",
    "PROXY user:secret@proxy.example:3128", "PROXY proxy.example:3128/path", "PROXY proxy.example:3128?secret=1",
    "PROXY proxy.example:3128#fragment", "PROXY proxy.example:3128\\path", "PROXY proxy.example:99999", "SOCKS5 proxy.example:1080\nHTTPS_PROXY=x"]) {
    assert.deepEqual(await codexSystemProxyEnvironment(URL, async () => route, {}), {}, route);
  }
});

test("transport recovery recognizes only the precise Codex rate-limits network error", () => {
  const error = { code: -32603, message: `failed to fetch codex rate limits: error sending request for url (${URL})` };
  assert.equal(codexRateLimitsNetworkUrl(error), URL);
  for (const candidate of [null, {}, { ...error, code: -32600 },
    { ...error, message: "failed to fetch codex rate limits: no snapshots returned" },
    { ...error, message: "failed to fetch codex rate limits: HTTP 401" },
    { ...error, message: error.message.replace("https://", "https://user:secret@") },
    { ...error, message: error.message.replace(URL, "not-a-url") }]) {
    assert.equal(codexRateLimitsNetworkUrl(candidate), null);
  }
});
