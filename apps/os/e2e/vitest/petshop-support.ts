// Helpers for the dummy-petshop integration proof (S5). The e2e runs in Node
// and talks to TWO deployed services:
//   - the OS deployment (APP_CONFIG_BASE_URL) over itx, as the project backend;
//   - the deployed dummy-petshop (the fake third party) over plain HTTP, both
//     as an OAuth provider/API and through its /__backdoor test console.
// The OS secret worker fetches petshop directly; nothing here proxies for it.

/** The seeded petshop OAuth client every deployment starts with (state.ts). */
export const PETSHOP_DEFAULT_CLIENT = {
  clientId: "petshop-default",
  clientSecret: "petshop-default-secret",
} as const;

/** The petshop the OS deployment can reach. Explicit `PETSHOP_BASE_URL` wins;
 * otherwise derive it from the OS base by swapping the first hostname label
 * (`os.iterate-preview-3.com` → `dummy-petshop.iterate-preview-3.com`). */
export function petshopBaseUrl(): string {
  const explicit = process.env.PETSHOP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const appBase = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!appBase) throw new Error("petshop e2e needs PETSHOP_BASE_URL or APP_CONFIG_BASE_URL");
  const url = new URL(appBase);
  url.hostname = url.hostname.replace(/^[^.]+\./, "dummy-petshop.");
  return url.origin;
}

function backdoorHeaders(): Record<string, string> {
  const secret = process.env.PETSHOP_BACKDOOR_SECRET?.trim();
  return secret ? { "x-petshop-backdoor": secret } : {};
}

async function petshopJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${petshopBaseUrl()}${path}`, init);
  if (!response.ok) {
    throw new Error(`petshop ${path} -> ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Register a fresh OAuth client (the second instance's credentials for the
 * two-client proof). */
export function petshopMintClient(): Promise<{ clientId: string; clientSecret: string }> {
  return petshopJson("/__backdoor/clients", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: "{}",
  });
}

/** Bump the access-token epoch so every outstanding access token is instantly
 * invalid — the deterministic way to force a real 401 → refresh. */
export function petshopExpireTokens(): Promise<{ accessTokenEpoch: number }> {
  return petshopJson("/__backdoor/expire-tokens", { method: "POST", headers: backdoorHeaders() });
}

export function petshopRotateSigningSecret(): Promise<{ webhookSigningSecret: string }> {
  return petshopJson("/__backdoor/rotate-signing-secret", {
    method: "POST",
    headers: backdoorHeaders(),
  });
}

/** Fire a signed webhook and get back the exact body petshop signed and the
 * `sha256=<hex>` signature it produced — what the OS side verifies with hmac(). */
export function petshopFireWebhook(input: {
  url: string;
  event?: unknown;
  badSignature?: boolean;
}): Promise<{ payload: string; signature: string; status: number; url: string }> {
  return petshopJson("/__backdoor/webhooks/fire", {
    method: "POST",
    headers: { "content-type": "application/json", ...backdoorHeaders() },
    body: JSON.stringify(input),
  });
}

/** Walk the OAuth authorize step in the consent-free test lane (`approve=1`)
 * and return the authorization code from the redirect. */
export async function petshopAuthorize(input: {
  clientId: string;
  redirectUri: string;
}): Promise<string> {
  const url = new URL(`${petshopBaseUrl()}/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", "e2e");
  url.searchParams.set("approve", "1");
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error(`petshop authorize did not redirect (${response.status})`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`petshop authorize redirect had no code: ${location}`);
  return code;
}

/** Exchange an authorization code for tokens, acting as the project backend
 * (the trusted party that holds the client secret at connect time). Uses HTTP
 * Basic client auth — the same form the OS refresh worker rides via a header
 * placeholder. */
export async function petshopExchangeCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  const response = await fetch(`${petshopBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  if (!response.ok) throw new Error(`petshop token exchange -> ${response.status}`);
  return (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
}

/**
 * The petshop secret worker source — the ~20 lines the whole "OAuth refresh
 * machinery" cooks down to (design §3). It reads its own material (tokens),
 * substitutes the access token into consumer requests through the pinned
 * outbound, and on a 401 refreshes: it POSTs the refresh_token to petshop's
 * token endpoint with the app credential as a `Basic getSecret(...)` HEADER
 * placeholder — so the worker never holds the client secret; the Secret DO
 * substitutes it (from the userspace app secret, or a platform secret in the
 * first-party lane — same file, only `appSecretPath` differs). Loader-ready
 * inline JS (bundle:false): no build step.
 */
function petshopWorkerSource(input: { appSecretPath: string; tokenUrl: string }): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const TOKEN_URL = ${JSON.stringify(input.tokenUrl)};
    const APP_SECRET_PATH = ${JSON.stringify(input.appSecretPath)};

    export default class PetshopSecretWorker extends WorkerEntrypoint {
      async fetch(request) {
        // env.SECRET.fetch is the default substituting egress (also our
        // globalOutbound): it swaps the accessToken placeholder and pins the
        // host. On 401, refresh once and retry — this is the entire refresh
        // policy, private to the worker (no refresh() convention).
        let response = await this.env.SECRET.fetch(request);
        if (response.status !== 401) return response;
        await this.#refresh();
        return await this.env.SECRET.fetch(request);
      }

      async #refresh() {
        const material = await this.env.SECRET.read();
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            // App-tier credential as a header placeholder: substituted en route
            // under the app secret's own pin, never held here.
            authorization: 'Basic getSecret("' + APP_SECRET_PATH + '", "basicAuth")',
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: material.refreshToken,
          }).toString(),
        });
        if (!response.ok) throw new Error("petshop refresh failed: " + response.status);
        const tokens = await response.json();
        await this.env.SECRET.update({
          material: {
            ...material,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? material.refreshToken,
          },
        });
      }
    }
  `;
}

/** A worker ref installing the source above as the connection secret's worker. */
export function petshopWorkerRef(input: { appSecretPath: string; tokenUrl: string }) {
  return {
    type: "stateless" as const,
    path: "/",
    source: {
      files: {
        type: "inline" as const,
        files: { "worker.js": petshopWorkerSource(input) },
      },
      options: { bundle: false, entryPoint: "worker.js" },
    },
  };
}

/** The three WebSocket credential shapes petshop and the OS side prove (design
 * §9 D6). Selected per request via the `x-relay-shape` header. */
export type PetshopWsShape = "frame" | "header" | "subprotocol";

/** The `x-relay-shape` header the gateway relay worker reads to pick the shape. */
export const PETSHOP_WS_SHAPE_HEADER = "x-relay-shape";

/**
 * The OS-side gateway RELAY secret worker (design §9 D6, and the OpenAI-Realtime
 * relay shape of §3). It proves that a jailed secret worker can hold an outbound
 * WebSocket to a third party with the credential injected THREE ways, dialing
 * petshop's gateway through `env.SECRET.fetch` — which is both the pinned,
 * substituting egress AND the jail's `globalOutbound`:
 *
 *   - "frame":       dial /gateway with no credential header, then read() the
 *                    access token and send it in an IDENTIFY frame (Discord
 *                    shape — the worker legitimately holds its own bytes).
 *   - "header":      dial /gateway-header with `Authorization: Bearer
 *                    getSecret(path, "accessToken")` — the placeholder is
 *                    substituted at the jailed outbound; the worker never holds
 *                    the token (OpenAI-Realtime shape).
 *   - "subprotocol": dial /gateway-subprotocol with the token placeholder inside
 *                    `Sec-WebSocket-Protocol` (browser-WS shape).
 *
 * Its fetch() has two modes so the proof needs no live socket back to the Node
 * client: a real consumer WS upgrade is accepted and pumped verbatim to petshop
 * (the design-faithful relay), while a PLAIN request drives the handshake
 * internally and returns the observed frames as JSON — the deterministic e2e
 * path. `SECRET_PATH` is this connection secret's own path (for the placeholder)
 * and `PETSHOP_ORIGIN` its pinned host, both inlined at install time.
 */
function petshopGatewayRelayWorkerSource(input: {
  petshopOrigin: string;
  secretPath: string;
}): string {
  return `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const PETSHOP_ORIGIN = ${JSON.stringify(input.petshopOrigin)};
    const SECRET_PATH = ${JSON.stringify(input.secretPath)};
    // The self-reference placeholder resolved (headers only) at the jailed
    // outbound — never held by this worker.
    const TOKEN_REF = 'getSecret("' + SECRET_PATH + '", "accessToken")';
    const PROBE_TIMEOUT_MS = 8000;

    export default class PetshopGatewayRelayWorker extends WorkerEntrypoint {
      async fetch(request) {
        const shape = request.headers.get(${JSON.stringify(PETSHOP_WS_SHAPE_HEADER)}) || "frame";
        const upstream = await this.#openUpstream(shape);
        if (!upstream) {
          return Response.json({ shape, outcome: "upstream_upgrade_failed", frames: [] }, { status: 502 });
        }
        // A live consumer WS → transparent relay (OpenAI-Realtime shape). A plain
        // request → internal probe returning JSON (the deterministic e2e path).
        if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
          return this.#relayToConsumer(upstream, shape);
        }
        return this.#probe(upstream, shape);
      }

      // Dial petshop's gateway for a shape and return the un-accepted socket, so
      // callers attach listeners synchronously right after accept() (no await in
      // between, or petshop's hello/ready could arrive before a listener exists).
      async #openUpstream(shape) {
        let url = PETSHOP_ORIGIN + "/gateway";
        const headers = { Upgrade: "websocket" };
        if (shape === "header") {
          url = PETSHOP_ORIGIN + "/gateway-header";
          headers.Authorization = "Bearer " + TOKEN_REF;
        } else if (shape === "subprotocol") {
          url = PETSHOP_ORIGIN + "/gateway-subprotocol";
          headers["Sec-WebSocket-Protocol"] = "petshop.v1, petshop.access-token." + TOKEN_REF;
        }
        // env.SECRET.fetch = the pinned, substituting egress (also our
        // globalOutbound): it resolves the placeholder in the upgrade headers and
        // relays the socket back through the Secret DO's WS-jail branch.
        const response = await this.env.SECRET.fetch(url, { headers });
        return response.webSocket || null;
      }

      // Discord frame shape only: hold our own token and send the IDENTIFY frame
      // (read() is legal in-jail — the isolate can only reach the pinned host,
      // ADR 0005). Header/subprotocol shapes already authed at the upgrade.
      async #identifyIfFrame(socket, shape) {
        if (shape !== "frame") return;
        const material = await this.env.SECRET.read();
        socket.send(JSON.stringify({ op: "identify", token: material.accessToken }));
      }

      async #probe(socket, shape) {
        const frames = [];
        socket.accept();
        const settled = new Promise((resolve) => {
          let probed = false;
          socket.addEventListener("message", (event) => {
            const raw = typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data);
            let frame;
            try { frame = JSON.parse(raw); } catch { frame = { op: "raw", raw }; }
            frames.push(frame);
            if (frame.op === "ready" && !probed) {
              probed = true;
              socket.send(JSON.stringify({ op: "probe", shape }));
            }
            if (frame.op === "echo") resolve("echoed");
            if (frame.op === "invalid") resolve("invalid");
          });
          socket.addEventListener("close", (event) => resolve("closed:" + event.code));
          socket.addEventListener("error", () => resolve("error"));
        });
        await this.#identifyIfFrame(socket, shape);
        const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS));
        const outcome = await Promise.race([settled, timeout]);
        try { socket.close(1000, "probe complete"); } catch (_e) {}
        return Response.json({ shape, outcome, frames });
      }

      async #relayToConsumer(upstream, shape) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        upstream.accept();
        server.accept();
        this.#pump(server, upstream);
        this.#pump(upstream, server);
        await this.#identifyIfFrame(upstream, shape);
        return new Response(null, { status: 101, webSocket: client });
      }

      #pump(from, to) {
        from.addEventListener("message", (event) => { try { to.send(event.data); } catch (_e) {} });
        from.addEventListener("close", (event) => { try { to.close(event.code, event.reason); } catch (_e) {} });
        from.addEventListener("error", () => { try { to.close(1011, "relay error"); } catch (_e) {} });
      }
    }
  `;
}

/** A worker ref installing the gateway relay worker on a connection secret. */
export function petshopGatewayRelayWorkerRef(input: { petshopOrigin: string; secretPath: string }) {
  return {
    type: "stateless" as const,
    path: "/",
    source: {
      files: {
        type: "inline" as const,
        files: { "worker.js": petshopGatewayRelayWorkerSource(input) },
      },
      options: { bundle: false, entryPoint: "worker.js" },
    },
  };
}
