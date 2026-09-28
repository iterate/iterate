// src/secret/exchange-jail.ts — THE JAIL a secret's exchange code runs in (`refresh: { kind:
// "worker", source }`, iterate/api `SecretRefresh`): the secret's facet (durable-object.ts) loads
// `source` through Worker Loader and calls its `exchange(material, fetch)` only on first use and on a
// 401 — never per request — and keeps only the object it returns as the next material.
//
// WHAT THE JAIL GUARANTEES, each enforced here:
//   • egress: `globalOutbound` is `PinnedOutbound` with the secret's origins as props — a request to
//     any other origin is answered here, never sent, and the refresh fails even when the code catches
//     the refusal (the prelude records it). Redirects are the runtime's to follow and come back
//     through `PinnedOutbound` each time; `connect()` sockets have no handler, so they fail.
//   • no authority: `env` is `{}` — no binding, no `ITX` loopback, no platform origin.
//   • bounded: `limits` caps CPU and subrequests per call.
//   • no logs: Worker Loader has no switch that turns a loaded worker's logs off (`tails` only adds
//     observers), so the prelude, which runs before the code's own module, replaces every `console`
//     method with a no-op; a thrown error is caught in the jail and comes back as a value, which the
//     facet redacts of every string in the material before it lands on the `secret/refreshed` fact.
//   • isolation: one isolate per (deployment, secret, pin, source), so module state never carries
//     one secret's material into another's login, and a new pin is a new `globalOutbound`.
import { WorkerEntrypoint } from "cloudflare:workers";
import type { SecretMaterial } from "iterate/api";
import { z } from "zod";
import { originPinned, sha256Hex } from "../secrets.ts";

/** The header `PinnedOutbound` answers a refused request with, naming the refused origin. */
const REFUSED_HEADER = "x-itx-exchange-refused";

/** THE EGRESS of loaded exchange code: its secret's pinned origins, and nothing else. Minted per
 *  isolate from `ctx.exports` with the origins as props, which the loaded code cannot reach. */
export class PinnedOutbound extends WorkerEntrypoint<object, { urls: string[] }> {
  override async fetch(request: Request): Promise<Response> {
    const { origin } = new URL(request.url);
    if (!originPinned(request.url, this.ctx.props.urls))
      return new Response(`${origin} is outside the secret's pin\n`, {
        status: 403,
        headers: { [REFUSED_HEADER]: origin },
      });
    const response = await fetch(request, { redirect: "manual" });
    if (!response.headers.has(REFUSED_HEADER)) return response;
    // an upstream's own copy of the header must not fail its secret's refresh
    const headers = new Headers(response.headers);
    headers.delete(REFUSED_HEADER);
    return new Response(response.body, { status: response.status, headers });
  }
}

/** Runs before the exchange code's module (imported first): swaps the global `fetch` for one that
 *  records a refused origin and throws, silences `console`, and keeps an unhandled rejection (whose
 *  reason may quote the material) off the runtime's own report. The original `fetch` stays in this
 *  module's closure; the code gets the wrapped one as its argument and as the global. */
const PRELUDE = `
const network = globalThis.fetch;
export const refused = [];
export async function pinnedFetch(input, init) {
  const response = await network(input, init);
  const origin = response.headers.get(${JSON.stringify(REFUSED_HEADER)});
  if (origin) {
    refused.push(origin);
    throw new Error("fetch to " + origin + " refused: outside the secret's pin");
  }
  return response;
}
globalThis.fetch = pinnedFetch;
for (const method of Object.keys(console)) console[method] = () => {};
addEventListener("unhandledrejection", (event) => event.preventDefault());
`;

/** The jail's entrypoint: the code's answer, or why there is none, as a value — never a throw. */
const JAIL = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { refused, pinnedFetch } from "./prelude.js";
import * as code from "./exchange.js";
const outsideThePin = () => ({ error: "the exchange code fetched " + refused[0] + ", outside the secret's pin" });
export class Jail extends WorkerEntrypoint {
  async exchange(material) {
    refused.length = 0;
    if (typeof code.exchange !== "function")
      return { error: "the exchange code exports no exchange(material, fetch) function" };
    let next;
    try {
      next = await code.exchange(material, pinnedFetch);
    } catch (error) {
      return refused.length ? outsideThePin() : { error: String((error && error.message) || error) };
    }
    if (refused.length) return outsideThePin();
    if (typeof next !== "object" || next === null || Array.isArray(next))
      return { error: "exchange returned no object — return the next material" };
    return { material: JSON.parse(JSON.stringify(next)) };
  }
}
`;

/** What the jail's `exchange` answers (JAIL above): the next material, or why there is none. */
const JailAnswer = z.object({
  material: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

/** The most one login may spend, per call: a few requests and a little parsing. */
const EXCHANGE_LIMITS = { cpuMs: 1_000, subRequests: 16 };

/** Load `source` in the jail for the secret `context`, pinned to `urls`, and run its `exchange` on
 *  `material`: the next material, or an Error whose message holds no string of the material. */
export async function runExchangeCode(input: {
  loader: WorkerLoader;
  /** `PinnedOutbound` minted with `urls` (the facet's `ctx.exports`): the code's whole egress. */
  pinnedOutbound: Fetcher;
  deployId: string;
  context: string;
  urls: string[];
  source: string;
  material: SecretMaterial;
}): Promise<Record<string, unknown>> {
  const { urls, source, material } = input;
  // ⚠️ every distinct id is a billed Dynamic Worker (context/worker-loader.ts): low cardinality —
  // one per deployment, secret, pin and source, never per refresh.
  const id = `secret-exchange:${await sha256Hex(JSON.stringify([input.deployId, input.context, urls, source]))}`;
  const worker = input.loader.get(id, () => ({
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
    mainModule: "jail.js",
    modules: { "jail.js": JAIL, "prelude.js": PRELUDE, "exchange.js": source },
    env: {},
    globalOutbound: input.pinnedOutbound,
    limits: EXCHANGE_LIMITS,
  }));
  let answer: unknown;
  try {
    answer = await worker
      .getEntrypoint<WorkerEntrypoint & { exchange(material: SecretMaterial): unknown }>("Jail")
      .exchange(material);
  } catch (error) {
    // the isolate failed to start, or ran out of its limits
    answer = { error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = JailAnswer.safeParse(answer).data;
  if (parsed?.material) return parsed.material;
  throw new Error(`exchange code: ${redacted(parsed?.error || "no answer", material)}`);
}

/** `message` with every string in `material` (of three characters or more) cut out, and short. */
function redacted(message: string, material: SecretMaterial): string {
  const strings: string[] = [];
  // every string of the material, however deep: the replacer sees each value once
  JSON.stringify(material, (_key, value: unknown) => {
    if (typeof value === "string") strings.push(value);
    return value;
  });
  let clean = message;
  for (const secret of strings.filter((value) => value.length >= 3))
    clean = clean.replaceAll(secret, "[redacted]");
  return clean.slice(0, 300);
}
