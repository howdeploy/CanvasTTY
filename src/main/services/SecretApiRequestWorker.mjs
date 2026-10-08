/** A self-contained factory so its bundled source never closes over renamed module bindings. */
function createSecretApiWorker() {
  const PROVIDER_SECRET_IDS = new Set([
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_API_KEY",
    "ZAI_API_KEY", "MINIMAX_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"
  ]);
  const API_PROTOCOLS = new Set(["openai-compatible", "anthropic-compatible", "google"]);
  const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const INPUT_KEYS = new Set(["secretId", "secret", "profile", "method", "path", "body"]);
  const MAX_PATH_CHARS = 2_048;
  const MAX_BODY_BYTES = 64 * 1_024;
  const MAX_RESPONSE_BYTES = 32 * 1_024;

  function normalizePublicHttpsBaseUrl(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 500) {
      throw new Error("API profile has no valid public HTTPS base URL.");
    }
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error("API profile has no valid public HTTPS base URL."); }
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port
      || hostname.includes(":") || /^\d+(?:\.\d+){3}$/u.test(hostname)
      || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost")
      || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".test")
      || hostname.endsWith(".invalid") || !hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part))) {
      throw new Error("API profile must use a public HTTPS base URL without credentials or a custom port.");
    }
    url.hostname = hostname;
    url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  }

  function buildProviderApiUrl(baseUrl, path) {
    const normalizedBaseUrl = normalizePublicHttpsBaseUrl(baseUrl);
    if (typeof path !== "string" || path.length < 1 || path.length > MAX_PATH_CHARS
      || /[\u0000-\u0020\\#]/u.test(path) || path.startsWith("//")
      || /^[a-z][a-z0-9+.-]*:/iu.test(path)) {
      throw new Error("API request path must be relative to the selected profile.");
    }
    const relativePath = path.startsWith("/") ? path.slice(1) : path;
    const pathname = relativePath.split("?", 1)[0] ?? "";
    if (!pathname || pathname.split("/").some((part) => {
      let decoded;
      try { decoded = decodeURIComponent(part); } catch { return true; }
      return part === "." || part === ".." || decoded === "." || decoded === "..";
    })) throw new Error("API request path is invalid.");
    const base = new URL(normalizedBaseUrl);
    const basePath = base.pathname === "/" ? "/" : `${base.pathname.replace(/\/$/u, "")}/`;
    const result = new URL(relativePath, `${base.origin}${basePath}`);
    if (result.origin !== base.origin || !result.pathname.startsWith(basePath)) {
      throw new Error("API request path escapes the selected profile.");
    }
    return result.href;
  }

  async function performSecretApiRequest(input, secret, fetchImpl = fetch, signal) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
      || !PROVIDER_SECRET_IDS.has(input.secretId) || typeof secret !== "string" || secret.length === 0
      || !input.profile || typeof input.profile !== "object" || !API_PROTOCOLS.has(input.profile.protocol)
      || !METHODS.has(input.method)) {
      throw new Error("API request is invalid.");
    }
    const url = buildProviderApiUrl(input.profile.baseUrl, input.path);
    let body;
    if (input.body !== undefined) {
      if (!input.body || typeof input.body !== "object" || Array.isArray(input.body) || input.method === "GET") {
        throw new Error("API request body must be a JSON object and cannot accompany GET.");
      }
      try { body = JSON.stringify(input.body); } catch { throw new Error("API request body is invalid."); }
      if (typeof body !== "string" || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        throw new Error("API request body exceeds 64 KB.");
      }
    }
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (input.profile.protocol === "openai-compatible") headers.Authorization = `Bearer ${secret}`;
    else if (input.profile.protocol === "anthropic-compatible") {
      headers["x-api-key"] = secret;
      headers["anthropic-version"] = "2023-06-01";
    } else headers["x-goog-api-key"] = secret;

    const response = await fetchImpl(url, { method: input.method, headers, body, redirect: "error", signal });
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: "", truncated: false };
    const chunks = [];
    let length = 0;
    let truncated = false;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
      if (length + chunk.byteLength > MAX_RESPONSE_BYTES) {
        const remaining = MAX_RESPONSE_BYTES - length;
        if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); length += remaining; }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // A capped stream may end inside a code point. Keep it pending rather than inventing a replacement.
    let decoded = new TextDecoder().decode(bytes, { stream: truncated });
    const encoded = new TextEncoder().encode(decoded);
    // Malformed input can expand to three-byte replacement characters during decoding.
    if (encoded.byteLength > MAX_RESPONSE_BYTES) {
      decoded = new TextDecoder().decode(encoded.subarray(0, MAX_RESPONSE_BYTES), { stream: true });
      truncated = true;
    }
    return { status: response.status, body: decoded, truncated };
  }

  async function readInput() {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 96 * 1024) throw new Error("request-too-large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  async function run() {
    try {
      const input = await readInput();
      if (!PROVIDER_SECRET_IDS.has(input.secretId)) throw new Error("secret-id-mismatch");
      const result = await performSecretApiRequest(input, input.secret);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch {
      process.stdout.write(JSON.stringify({ ok: false }));
      process.exitCode = 1;
    }
  }

  return { normalizePublicHttpsBaseUrl, buildProviderApiUrl, performSecretApiRequest, run };
}

const worker = createSecretApiWorker();
export const normalizePublicHttpsBaseUrl = worker.normalizePublicHttpsBaseUrl;
export const buildProviderApiUrl = worker.buildProviderApiUrl;
export const performSecretApiRequest = worker.performSecretApiRequest;
// The factory is self-contained: compiled or minified names are all internal to its source text.
export const SECRET_API_REQUEST_WORKER_SOURCE = `void (${createSecretApiWorker.toString()})().run();`;
