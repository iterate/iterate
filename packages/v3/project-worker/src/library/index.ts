// library/index.ts — THE LIBRARY: the built-ins that could be userspace. context/built-ins.ts has TWO
// groups: ROOTS, implemented against ctx/env (the log, the stub registry, the rule table, the two
// hosts, the bindings), and THIS FOLDER — plain compiled-in first-party code whose ONLY dependency is
// `itx`, the same dotted handle a loaded worker gets from `env.ITX.get()`. That signature IS the
// layering (the owner's litmus test, 2026-09-04: "could this be written in a userspace worker?"): a
// library module takes `itx` and nothing else, so it could move to a userspace worker unchanged; the
// surface shows no level — `itx.connectToMcp(url)` reads like `itx.ai.run(...)` — the folder and the
// signature do. boundary.test.ts pins the rule (no runtime import from the stream, the DO, the fetch
// module or the context folder, except invoke-handle.ts, the pipelinable-handle primitive).
//
// The verbs: `connectToMcp` · `connectToOpenApi` · `connectToCapnweb`. Each returns a connection
// RpcTarget a caller can hold across calls, and each does ALL its HTTP through `itx.fetch` (egress:
// `{{secret:project:NAME}}` placeholders in headers substitute for free; a user rule shadowing
// `itx.fetch` redirects the library too, which is how a test fakes a remote). `connectToGraphql` is the
// obvious next member of the family and does not exist yet.

import type { IterateContext } from "../iterate-context.ts";
import { connectToCapnweb, type CapnwebConnection, type CapnwebConnectOptions } from "./capnweb.ts";
import { connectToMcp, type McpConnection, type McpConnectOptions } from "./mcp.ts";
import {
  connectToOpenApi,
  type OpenApiConnection,
  type OpenApiConnectOptions,
  type OpenApiDocument,
} from "./openapi.ts";

/** What a library module is handed: the itx handle, narrowed to what the library uses today
 *  (`fetch`). Widen it HERE when a module needs more of itx — never by importing something else. */
export type LibraryItx = Pick<IterateContext, "fetch">;

/** The library's roots, exactly as the built-ins record spreads them in: each verb closed over ONE
 *  `itx`. `BuiltInScope` (context/built-ins.ts) restates these three signatures for the typed surface. */
export interface LibraryRoots {
  /** Connect to an MCP server over Streamable HTTP; the connection's tools are `callTool(name, args)`
   *  and, for every tool whose name is a legal identifier, a method of that name. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnection>;
  /** Connect to an OpenAPI 3 service from its document or the URL of one; every `operationId` is a
   *  method taking one input object (path, query and body fields together). */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnection>;
  /** Connect to a remote capnweb API: its main object as a pipelinable handle — dotted calls chain
   *  with no round trip per step. */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
}

/** Close the three verbs over one `itx`. Nothing is constructed here: a DO wake pays nothing for the
 *  library until a verb runs. */
export function buildLibrary(itx: LibraryItx): LibraryRoots {
  return {
    connectToMcp: (url, options) => connectToMcp(itx, url, options),
    connectToOpenApi: (specOrUrl, options) => connectToOpenApi(itx, specOrUrl, options),
    connectToCapnweb: (url, options) => connectToCapnweb(itx, url, options),
  };
}

export type {
  CapnwebConnection,
  CapnwebConnectOptions,
  McpConnection,
  McpConnectOptions,
  OpenApiConnection,
  OpenApiConnectOptions,
  OpenApiDocument,
};
