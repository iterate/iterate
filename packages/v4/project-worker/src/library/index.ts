// library/index.ts — THE LIBRARY: the built-ins that could be userspace. context/built-ins.ts has TWO
// groups: ROOTS, implemented against ctx/env (the log, the stub registry, the rule table, the two
// hosts, the bindings), and THIS FOLDER — plain compiled-in first-party code whose ONLY dependency is
// `itx`, the same dotted handle a loaded worker gets from `env.ITX.get()`. That signature IS the
// layering (the owner's litmus test: "could this be written in a userspace worker?"): a library module
// takes `itx` and nothing else, so it could move to a userspace worker unchanged (capnweb.ts once the
// SDK exports `InvokeHandle`); the surface shows no level — `itx.connectToMcp(url)` reads like
// `itx.ai.run(...)` — the folder and the signature do. boundary.test.ts pins the rule (no runtime
// import from the stream, the DO, the fetch module or the context folder, except invoke-handle.ts,
// the pipelinable-handle primitive).
//
// The verbs: `connectToMcp` · `connectToOpenApi` · `connectToCapnweb`. Each returns a connection
// RpcTarget a caller can hold across calls, and each does ALL its HTTP through `itx.fetch` (egress:
// `{{secret:project:NAME}}` placeholders in headers substitute for free; a user rule shadowing
// `itx.fetch` redirects the library too, which is how a test fakes a remote). `connectToGraphql` is the
// obvious next member of the family and does not exist yet.
//
// LIVE CONNECTIONS ARE MEMOIZED per context: a connector reached THROUGH a rewrite rule
// (`provide('itx.tools', "itx.connectToMcp(url)")`, the documented composition) is a connect per
// call as an expression — a fresh MCP session, an open WebSocket, that no intermediate holder ever
// disposes. So `buildLibrary` keeps every connection it opened, by (verb, url, options), hands the
// same one back while it lives, and `releaseConnections()` closes them all — the context's idle
// quiesce calls it beside returning its borrowed stubs, since a held connection pins the context
// awake exactly like a borrowed stub. A connection closed by a holder or broken by the far side
// reopens itself on its next use (mcp.ts, capnweb.ts), so a memoized one is never dead.

import type { BuiltInScope } from "../context/built-ins.ts";
import { reportIssue } from "../lib/errors.ts";
import { connectToCapnweb, type CapnwebConnection, type CapnwebConnectOptions } from "./capnweb.ts";
import { connectToMcp, type McpConnection, type McpConnectOptions } from "./mcp.ts";
import {
  connectToOpenApi,
  type OpenApiConnection,
  type OpenApiConnectOptions,
  type OpenApiDocument,
} from "./openapi.ts";

/** What a library module is handed: the itx handle (the record's own dotted surface), narrowed to
 *  what the library uses today (`fetch`). Widen it HERE when a module needs more of itx — never by
 *  importing something else. */
export type LibraryItx = Pick<BuiltInScope, "fetch">;

/** The library's roots, exactly as the built-ins record spreads them in: each verb closed over ONE
 *  `itx`. `BuiltInScope` (context/built-ins.ts) extends this, so the typed surface has them once. */
export interface LibraryRoots {
  /** An MCP server over Streamable HTTP: `callTool(name, args)`, `listTools()`, and one method per
   *  tool whose name is a legal identifier. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnection>;
  /** An OpenAPI 3 service from its document or the URL of one: one method per `operationId`, taking
   *  one input object (path, query, header and body fields together); `call(operationId, input)` too. */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnection>;
  /** A remote capnweb API's main object as a pipelinable handle — a WebSocket session through egress
   *  (default) or one HTTP batch per chain (`{ transport: "batch" }`); dotted calls chain with no round
   *  trip per step. */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
}

/** The library, built once per context: the three verbs closed over one `itx`, memoizing the live
 *  connections they open, and the one release door. Nothing is constructed here: a wake pays nothing
 *  for the library until a verb runs. */
export function buildLibrary(itx: LibraryItx): {
  roots: LibraryRoots;
  /** Close every connection the library holds (the idle quiesce's call); the next use reopens. */
  releaseConnections(): void;
} {
  const liveConnections = new Map<string, Promise<unknown>>();
  const memoized = <T>(key: unknown[], open: () => Promise<T>): Promise<T> => {
    const memoKey = JSON.stringify(key, keySorted);
    let connection = liveConnections.get(memoKey) as Promise<T> | undefined;
    if (!connection) {
      connection = open();
      liveConnections.set(memoKey, connection);
      // a connect that FAILS is not kept — the next call retries (the caller sees the rejection)
      connection.catch(() => liveConnections.delete(memoKey));
    }
    return connection;
  };
  return {
    roots: {
      connectToMcp: (url, options) =>
        memoized(["mcp", url, options], () => connectToMcp(itx, url, options)),
      connectToOpenApi: (specOrUrl, options) =>
        memoized(["openapi", specOrUrl, options], () => connectToOpenApi(itx, specOrUrl, options)),
      connectToCapnweb: (url, options) =>
        memoized(["capnweb", url, options], () => connectToCapnweb(itx, url, options)),
    },
    releaseConnections: () => {
      for (const connection of liveConnections.values())
        void connection
          .then(async (connection) => {
            const close = (connection as { close?: () => Promise<void> }).close;
            if (close) await close.call(connection);
            else (connection as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
          })
          .catch((error) => reportIssue("library.release-connections", error));
      liveConnections.clear();
    },
  };
}

/** Object keys sorted, so two spellings of one options object are one memo key. */
const keySorted = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, (value as Record<string, unknown>)[k]]),
      )
    : value;

// ── what the three connectors share ──

/** A per-connection subclass whose PROTOTYPE carries one method per name — prototype members are what
 *  Workers RPC and capnweb traverse, so `conn.echo({ … })` works held across calls, not only inside
 *  one dotted expression. A name the base already declares (its own methods, `constructor`, whatever
 *  `RpcTarget` adds) stays reachable through the generic door only; so does a name that is not an
 *  identifier, and `then` — a thenable connection would be adopted as a promise by any await and
 *  never settle. */
export function subclassWithMethods<Base extends abstract new (...args: never[]) => object>(
  base: Base,
  names: string[],
  call: (self: InstanceType<Base>, name: string, input: unknown) => unknown,
): Base {
  const Subclass = class extends (base as abstract new (...args: never[]) => object) {};
  for (const name of names) {
    if (name === "then" || name in Subclass.prototype || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    Object.defineProperty(Subclass.prototype, name, {
      value(this: InstanceType<Base>, input?: unknown) {
        return call(this, name, input);
      },
      writable: true,
      configurable: true,
    });
  }
  return Subclass as unknown as Base;
}

/** The error for a response that refused: `<what> returned <status>: <the first 300 characters>`. */
export async function responseRefusal(response: Response, what: string): Promise<Error> {
  const snippet = await responseTextPrefix(response);
  return new Error(`${what} returned ${response.status}${snippet ? `: ${snippet}` : ""}`);
}

/** Bounded diagnostic text from a refusal. The body is cancelled once its public prefix is known. */
export async function responseTextPrefix(response: Response, limit = 300): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    return text.slice(0, limit);
  } finally {
    await reader.cancel();
  }
}

/** The response, or the refusal thrown — ONE spelling for every non-2xx the connectors meet. */
export async function refuseUnlessOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  throw await responseRefusal(response, what);
}
