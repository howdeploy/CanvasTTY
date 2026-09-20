import srp from "secure-remote-password/client.js";
import { LOCAL_DISCOVERY_ORIGINS, PAIRING_IDENTITY, sixDigitCode } from "../../../src/shared/localDiscovery.ts";
import {
  localOrigin,
  sealLocal,
  unsealLocal,
  validateLocalConnection,
} from "../../../src/shared/localLink.ts";

/** Probe addresses without credentials; send each actual action only once. */
export function localFetcher(
  connection,
  { fetcher = fetch, allowLoopback = false, probeTimeout = 3000 } = {},
) {
  const validated = validateLocalConnection(connection, allowLoopback);
  let preferred = "",
    discovery = null;
  async function exchange(origin, packet, signal) {
    const response = await fetcher(origin + "/g2/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packet),
      credentials: "omit",
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Local connection rejected");
    const reply = await response.json();
    if (reply.id !== packet.id) throw new Error("invalid-response-id");
    const result = await unsealLocal(validated, reply, "response");
    if (
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 599
    )
      throw new Error("invalid-response-status");
    return result;
  }
  async function discover(signal) {
    if (preferred) return preferred;
    if (discovery) return discovery;
    discovery = (async () => {
      const controllers = validated.origins.map(() => new AbortController());
      try {
        const packet = await sealLocal(
          validated,
          {
            path: "/g2/api/home",
            method: "GET",
            token: "",
            sentAt: Date.now(),
          },
          "request",
        );
        preferred = await Promise.any(
          validated.origins.map(async (origin, index) => {
            const signals = [
              controllers[index].signal,
              AbortSignal.timeout(probeTimeout),
            ];
            if (signal) signals.push(signal);
            // A decryptable 401 proves this is the paired computer, without sharing a bearer.
            const result = await exchange(
              origin,
              packet,
              AbortSignal.any(signals),
            );
            if (result.status !== 401)
              throw new Error("Unexpected pairing probe");
            return origin;
          }),
        );
        return preferred;
      } finally {
        for (const controller of controllers) controller.abort();
        discovery = null;
      }
    })();
    return discovery;
  }
  const send = async (input, options = {}) => {
    const url = new URL(input, validated.origins[0]);
    if (
      !validated.origins.includes(url.origin) ||
      !url.pathname.startsWith("/g2/api/")
    )
      throw new Error("invalid-local-target");
    const headers = new Headers(options.headers);
    try {
      const origin = await discover(options.signal);
      const packet = await sealLocal(
        validated,
        {
          path: url.pathname + url.search,
          method: options.method || "GET",
          token: (headers.get("Authorization") || "").replace(/^Bearer /, ""),
          body: options.body ? JSON.parse(options.body) : undefined,
          sentAt: Date.now(),
        },
        "request",
      );
      const result = await exchange(origin, packet, options.signal);
      if (
        url.pathname === "/g2/api/home" &&
        result.status === 200 &&
        Array.isArray(result.body?.localOrigins)
      ) {
        const origins = result.body.localOrigins
          .slice(0, 8)
          .map((value) => localOrigin(value, allowLoopback));
        validated.origins = [
          ...new Set([...origins, ...validated.origins]),
        ].slice(0, 8);
      }
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      preferred = "";
      if (options.signal?.aborted) throw options.signal.reason;
      throw new Error(
        "Нет локальной связи. Откройте CanvasTTY на Mac и подключите телефон к той же сети.",
        { cause: error },
      );
    }
  };
  send.connection = () => ({ ...validated, origins: [...validated.origins] });
  return send;
}
export function readLocalConnection(value) {
  const saved = JSON.parse(value);
  if (!/^[a-f0-9]{64}$/.test(saved?.token))
    throw new Error("invalid-saved-token");
  return {
    token: saved.token,
    connection: validateLocalConnection(saved.connection),
  };
}

export async function connectionFromCode(value, {
  fetcher = fetch, signal, origins = LOCAL_DISCOVERY_ORIGINS, allowLoopback = false, onTrace = () => {},
} = {}) {
  const code = sixDigitCode(value);
  if (!Array.isArray(origins) || !origins.length || origins.length > 8)
    throw new Error("invalid-discovery-origins");
  const controllers = origins.map(() => new AbortController());
  let found = false;
  const failures = [];
  const report = (message) => { try { onTrace(message); } catch {} };
  try {
    return await Promise.any(origins.map(async (candidate, index) => {
      let stage = "validate-origin", status = 0;
      try {
      const origin = localOrigin(candidate, allowLoopback);
      const signals = [controllers[index].signal, AbortSignal.timeout(15000)];
      if (signal) signals.push(signal);
      const requestSignal = AbortSignal.any(signals);
      const get = async (path, body) => {
        stage = path; status = 0;
        report(`${new URL(origin).hostname} ${stage} start`);
        const r = await fetcher(origin + path, {
          method: body ? "POST" : "GET",
          ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
          credentials: "omit", redirect: "error", signal: requestSignal,
        });
        status = r.status;
        report(`${new URL(origin).hostname} ${stage} HTTP ${status}`);
        if (!r.ok) throw new Error("pairing-unavailable");
        return r.json();
      };
      const offer = await get("/g2/discover");
      stage = "validate-offer";
      if (offer.type !== "canvastty-local" || offer.version !== 2)
        throw new Error("invalid-offer");
      found = true;
      report(`${new URL(origin).hostname} offer pairing=${offer.pairing === true}`);
      if (offer.pairing !== true) throw new Error("pairing-inactive");
      stage = "srp-client-start";
      const ephemeral = srp.generateEphemeral();
      const challenge = await get("/g2/pair-start", { public: ephemeral.public });
      if (!/^[a-f0-9]{64}$/.test(challenge.id) || !/^[a-f0-9]{64}$/.test(challenge.salt) ||
        !/^[a-f0-9]{512}$/.test(challenge.public)) throw new Error("invalid-pairing-challenge");
      const key = srp.derivePrivateKey(challenge.salt, PAIRING_IDENTITY, code);
      const session = srp.deriveSession(ephemeral.secret, challenge.public, challenge.salt,
        PAIRING_IDENTITY, key);
      const reply = await get("/g2/pair-finish", { id: challenge.id, proof: session.proof });
      if (!/^[a-f0-9]{64}$/.test(reply.proof)) throw new Error("invalid-server-proof");
      srp.verifySession(ephemeral.public, session, reply.proof);
      const result = await unsealLocal({ version: 1, computer: challenge.id,
        key: session.key, origins: [origin] }, reply.packet, "response");
      const connection = validateLocalConnection(result.connection, allowLoopback);
      if (!connection.origins.includes(origin) || result.code !== code)
        throw new Error("invalid-pairing-result");
      return { connection, code };
      } catch (error) {
        const host = new URL(candidate).hostname;
        const detail = `${host} ${stage} ${status ? `HTTP ${status} ` : ""}${error.name}: ${String(error.message).slice(0,100)}`;
        failures[index] = detail; report(detail); throw error;
      }
    }));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const failure = new Error(found
      ? "Код не принят или истёк. Получите новый шестизначный код на Mac."
      : "Mac не найден. Откройте CanvasTTY → Управление → Even G2 и проверьте, что оба устройства в одной Wi-Fi сети.", { cause: error });
    failure.diagnostics = failures;
    throw failure;
  } finally { controllers.forEach(c => c.abort()); }
}
