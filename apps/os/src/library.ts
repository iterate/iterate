// library.ts — the library: `buildLibrary` closes the verbs below over one `itx` and memoizes the
// live connections. The connectors (library/capnweb.ts, mcp.ts, openapi.ts) are userspace-shaped —
// written against `itx.fetch` alone, so a userspace worker could carry them unchanged. `run` and the
// entity roots (`repos`, `workspaces`) are platform sugar spelled at the fixed point,
// `itx.builtins` — the word loaded code may not say; `files` is a path namespace over `itx.r2`.
// library.test.ts pins what every library file may import at runtime.

import { z } from "zod";
import { keySortedForPrint, InvokeHandle, print, type ItxExpression } from "iterate/expression";
import { codedError, errorCode, resolveContextPath, withTimeout } from "iterate/lib";
import type { EventInput, StreamEvent } from "iterate/stream/processor";
import type { RunSettled, RunSettlement } from "iterate/stream/run";
import type { Caller } from "./caller.ts";
import WITH_ITX_MODULE from "./generated/with-itx-module.js";
import type { BuiltInScope } from "./context/built-ins.ts";
import { RepoContract } from "./repo/contract.ts";
import type { RepoDurableObject, repoVerbs } from "./repo/durable-object.ts";
import { WorkspaceContract } from "./workspace/contract.ts";
import type { WorkspaceDurableObject, workspaceVerbs } from "./workspace/durable-object.ts";
import {
  connectToCapnweb,
  type CapnwebConnectOptions,
  type CapnwebConnection,
} from "./library/capnweb.ts";
import {
  connectToMcp,
  type McpConnectOptions,
  type McpConnectionRpcTarget,
} from "./library/mcp.ts";
import {
  connectToOpenApi,
  type OpenApiConnectOptions,
  type OpenApiConnectionRpcTarget,
  type OpenApiDocument,
} from "./library/openapi.ts";

/** What a library module is handed: the itx handle (the record's own dotted surface), narrowed to
 *  what the library uses — `fetch`, the connectors' HTTP; `r2`, the files' storage; `builtins`, the
 *  fixed point `run` and the entity roots spell their own hops at. Widen it here when a module
 *  needs more of itx — never by importing something else. */
export type LibraryItx = Pick<BuiltInScope, "fetch" | "r2" | "builtins">;

/** The library's roots, exactly as the built-ins record spreads them in: each verb closed over ONE
 *  `itx`. `BuiltInScope` (context/built-ins.ts) extends this, so the typed surface has them once. */
export interface LibraryRoots {
  /** A script — the text of `async (itx) => { … }` — run ONCE against this context, ON THE LOG:
   *  `run` appends `itx/run-requested { code }` (attributed to the caller), the context's
   *  runner starts it at that commit in a confined isolate (`executeScript`: a WorkerEntrypoint
   *  whose `run` hands the script the scope of one `withItx` round trip), and `run` resolves with
   *  the `run-settled` event's result — or rejects with its error. So every script that ever ran is
   *  a pair of events on the context it ran against, and a run the context's restart interrupted —
   *  or that was still running at its ten-minute deadline (RUN_DEADLINE_MS) — is settled as such,
   *  never re-run. JSON in, JSON out. A script bakes in its own values — an agent writes it whole
   *  (an alternative to a tool call), so `run` takes no arguments. */
  run(script: string): Promise<unknown>;
  /** An MCP server over Streamable HTTP: `callTool(name, args)`, `listTools()`, and one method per
   *  tool whose name is a legal identifier. */
  connectToMcp(url: string, options?: McpConnectOptions): Promise<McpConnectionRpcTarget>;
  /** An OpenAPI 3 service from its document or the URL of one: one method per `operationId`, taking
   *  one input object (path, query, header and body fields together); `call(operationId, input)` too. */
  connectToOpenApi(
    specOrUrl: string | OpenApiDocument,
    options?: OpenApiConnectOptions,
  ): Promise<OpenApiConnectionRpcTarget>;
  /** A remote capnweb API's main object as a pipelinable handle — a WebSocket session through egress
   *  (default) or one HTTP batch per chain (`{ transport: "batch" }`); dotted calls chain with no round
   *  trip per step. */
  connectToCapnweb(url: string, options?: CapnwebConnectOptions): Promise<CapnwebConnection>;
  /** A repo (src/repo/): a stream on any path whose `repo` facet lands the commit facts. `get(path)`
   *  is the handle — the facet's verbs plus the typed `append` of the repo's own events; `list()`
   *  and `create(path)` are the collection's on the `project` facet at `/`. */
  repos: EntityRoot<
    EntityHandle<RepoDurableObject, (typeof repoVerbs)[number], typeof RepoContract>
  >;
  /** A workspace (src/workspace/): the workspace of any context, at most one per path. `get(path)`
   *  is the handle — the facet's verbs plus the typed `append` of the workspace's own events;
   *  `list()` and `create(path)` are the collection's on the `project` facet at `/`. */
  workspaces: EntityRoot<
    EntityHandle<WorkspaceDurableObject, (typeof workspaceVerbs)[number], typeof WorkspaceContract>
  >;
  /** THE FILES: project file storage as a PATH namespace over `itx.r2`
   *  — a file is its path (leading slash), its bytes and a content type; last write wins, no
   *  events. `get(path)` is a handle: `.put({ contentType, data })` (data: bytes, or a string that
   *  is base64 or a `data:` URL) → the record, `.bytes()`, `.head()` (null when absent), `.delete()`,
   *  and `.url({ method?, expiresInSeconds? })` — a signed URL on the project host that downloads
   *  (`GET`, the default) or uploads (`PUT`) the file, `itx.r2.presign` underneath. `list(prefix?)`
   *  lists records under a prefix. */
  files: {
    get(path: string): InvokeHandle & FileHandle;
    list(prefix?: string): Promise<FileRecord[]>;
  };
}

/** An entity root (`itx.repos`, `itx.workspaces`): `get(path)` the handle, typed as the facet it
 *  dispatches to; `list()`, `create(path)` and `delete(path)` the collection's. */
type EntityRoot<Handle> = {
  get(path: string): InvokeHandle & Handle;
  list(): Promise<{ path: string; createdAt: string }[]>;
  create(path: string): Promise<{ path: string }>;
  /** The entity's deletion saga on that path: the request, the death certificate (cross-posted to `/`, the catalog drops it), then the row disabled. */
  delete(path: string): Promise<{ path: string }>;
};

/** What an entity handle's dotted members reach: the facet's own `Verbs`, and the typed `append` of
 *  the entity's events on that context (`entityHandle`). */
type EntityHandle<Facet, Verbs extends keyof Facet, Contract> = Pick<Facet, Verbs> & {
  append(...events: EventInput<Contract>[]): Promise<StreamEvent[]>;
};

/** A stored file as `itx.files` answers it: its path, content type and size. */
type FileRecord = { path: string; contentType: string; size: number };
/** What a file handle's dotted members reach. */
type FileHandle = {
  put(input: {
    contentType?: string;
    data: Uint8Array | ArrayBuffer | string;
  }): Promise<FileRecord>;
  bytes(): Promise<Uint8Array>;
  head(): Promise<FileRecord | null>;
  delete(): Promise<void>;
  url(input?: {
    method?: "GET" | "PUT";
    expiresInSeconds?: number;
  }): Promise<{ url: string; expiresAt: string }>;
};

/** What `buildLibrary` closes over beside `itx`. */
type LibraryDeps = {
  /** WHO is calling right now — read when a handle is MADE (a handle is a value that outlives the
   *  call; its later dispatches arrive with no ambient caller), so a relative path (`./x` from a
   *  child, answered at the root through its link) means the caller's, and a creation's parent
   *  link names the caller's context. */
  caller: () => Caller;
  /** This context's path — a relative path's base when the caller carries none. */
  path: string;
};

/** The library, built once per context: the verbs closed over one `itx`, memoizing the live
 *  connections the connectors open, and the one release method. Nothing is constructed here: a wake
 *  pays nothing for the library until a verb runs. */
export function buildLibrary(
  itx: LibraryItx,
  deps: LibraryDeps,
): {
  roots: LibraryRoots;
  /** Whether the library holds an open SOCKET — a capnweb WebSocket session — the one kind of
   *  connection that keeps this actor resident (measured: like a borrowed stub), so the pins' release
   *  arms for it. An MCP or OpenAPI client is HTTP handshakes: it holds nothing and pins nothing. */
  holdsOpenSocket(): boolean;
  /** Close every connection the library holds (the pins' release's call); the next use reopens. */
  releaseConnections(): void;
} {
  const liveConnections = new Map<string, { connection: Promise<unknown>; holdsSocket: boolean }>();
  const memoized = <T>(
    key: unknown[],
    holdsSocket: boolean,
    open: () => Promise<T>,
  ): Promise<T> => {
    const memoKey = JSON.stringify(key, keySortedForPrint); // keys sorted: two spellings, one key
    let connection = liveConnections.get(memoKey)?.connection as Promise<T> | undefined;
    if (!connection) {
      connection = open();
      liveConnections.set(memoKey, { connection, holdsSocket });
      // a connect that FAILS is not kept — the next call retries (the caller sees the rejection)
      connection.catch(() => liveConnections.delete(memoKey));
    }
    return connection;
  };
  return {
    roots: {
      run: (script) => runScript(itx, script),
      connectToMcp: (url, options) =>
        memoized(["mcp", url, options], false, () => connectToMcp(itx, url, options)),
      connectToOpenApi: (specOrUrl, options) =>
        memoized(["openapi", specOrUrl, options], false, () =>
          connectToOpenApi(itx, specOrUrl, options),
        ),
      connectToCapnweb: (url, options) =>
        memoized(["capnweb", url, options], options?.transport !== "batch", () =>
          connectToCapnweb(itx, url, options),
        ),
      repos: entityRoot(itx, deps, "repo", RepoContract),
      workspaces: entityRoot(itx, deps, "workspace", WorkspaceContract),
      files: {
        get: (path) => fileHandle(itx, path),
        list: async (prefix = "") => {
          // Every page: the semantic layer answers the whole set under a prefix.
          const records: FileRecord[] = [];
          for (let cursor: string | undefined; ; ) {
            const page = await itx.r2.list({ prefix: fileKey(prefix), cursor });
            for (const object of page.objects) records.push(fileRecord(object));
            if (!page.truncated) return records;
            cursor = page.cursor;
          }
        },
      },
    },
    holdsOpenSocket: () => [...liveConnections.values()].some((c) => c.holdsSocket),
    releaseConnections: () => {
      // `close()` where a connection has one (the graceful half-close), else its dispose; a release
      // that throws is logged, not reported as an issue — the far end is any server a caller
      // connected to, and one that will not close is a fact worth a warning, not a platform fault.
      for (const [memoKey, { connection }] of liveConnections)
        void connection
          .then((c) => {
            const held = c as { close?: () => unknown; [Symbol.dispose]?: () => void };
            return held.close ? held.close() : held[Symbol.dispose]?.();
          })
          .catch((error: unknown) =>
            console.warn({
              event: "library.connection-close-failed",
              memoKey,
              message: String(error),
            }),
          );
      liveConnections.clear();
    },
  };
}

// ── run ── `itx.run(script)`: a request on the log, its settlement awaited. `runScript` appends
// `itx/run-requested` and waits for the `run-settled` naming that request's offset; the EXECUTION is the
// context DO's runner (iterate-context-durable-object.ts `#executeRun`), which calls `executeScript`
// below at the request's commit — so a literal `run-requested` appended by anyone (a client over
// /api, the agent's loop, a schedule) runs exactly as `itx.run` does, and both leave the same pair
// of events. The script is the text of a function of one parameter — `async (itx) => …` — spliced
// VERBATIM into the template below (a caller's own code in its own confined isolate: the
// trusted-client doctrine), so a text that is not one function expression fails at load, in the
// loader's words. It takes no arguments: a script is an agent's whole output (an alternative to a
// tool call), its values baked in. The template is the smallest WorkerEntrypoint that hosts it:
// `run()` hands it the scope of ONE `withItx` round trip, as the SDK's ConfigWorker does, so the
// scope and every call the script made through it are released when it settles — its unawaited ones
// and its deadline's included.
// The call rides `itx.workers.get(...).run()` on the handle the library holds, so a rule on
// `itx.workers` applies to it like any other call.

/** THE RUN DEADLINE: ten minutes from the moment the runner starts a script. A run that has not
 *  finished by then is settled `failed` / `deadline`, and nothing it started stays in flight: the
 *  loaded `run()` gives up on its own (the module below — the runner cannot cancel a Workers-RPC call
 *  it made, and a call in flight keeps this context resident and billed), the runner stops waiting
 *  (`runSettlementOf`) and a caller's `itx.run` returns. Ten minutes is what an agent's turn already
 *  allows: its model request expires after ten, and its feed closes a code step at ten
 *  (apps/agents `adaptContextRuns`). */
export const RUN_DEADLINE_MS = 10 * 60_000;

/** The module `run` loads: `script` spliced in as `const script = (…)`, run inside ONE `withItx`
 *  round trip (the SDK's, bundled alone as `with-itx.js`: a script's isolate never loads the whole
 *  SDK) and raced against the deadline. Its value becomes JSON inside the round trip: the log carries
 *  JSON, and a live value (a handle, a function) is released with the round trip. Exported for the
 *  unit pin. */
export function runScriptModule(script: string): { "cap.js": string; "with-itx.js": string } {
  return {
    "cap.js": [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      'import { withItx } from "./with-itx.js";',
      `const script = (${script});`,
      "export default class extends WorkerEntrypoint {",
      "  async run() {",
      "    let deadline;",
      "    try {",
      "      return await withItx(this.env.ITX, async (itx) => {",
      "        const value = await Promise.race([",
      "          script(itx),",
      "          new Promise((_, reject) => {",
      `            deadline = setTimeout(() => reject(new Error("itx.run: the script did not finish within ${RUN_DEADLINE_MS / 60_000} minutes")), ${RUN_DEADLINE_MS});`,
      "          }),",
      "        ]);",
      "        const json = JSON.stringify(value);",
      "        return json === undefined ? undefined : JSON.parse(json);",
      "      });",
      "    } finally {",
      "      clearTimeout(deadline);",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
    "with-itx.js": WITH_ITX_MODULE,
  };
}

/** THE EXECUTION: the script's one call in its confined isolate — what the context's runner does
 *  with a requested run. Same text, same module: the loader's content hash reuses the warm isolate. */
export async function executeScript(itx: LibraryItx, code: string): Promise<unknown> {
  // TWO dotted calls, never one chain: the handle's dotted surface dispatches at the first call, and
  // in-process the record hands the worker's handle back as a VALUE (a genuine RpcTarget), so `run`
  // is its own dispatch on that value — exactly what a remote holder of the same handle would do.
  const worker = (await itx.builtins.workers.get({ source: runScriptModule(code) })) as unknown as {
    run(): Promise<unknown>;
  };
  return worker.run();
}

/** THE RUNNER'S SETTLEMENT of one execution (iterate-context-durable-object.ts `#executeRun`): the
 *  value through THE JSON BOUNDARY — a round trip keeps what the log carries (undefined and functions
 *  drop; a bigint or a cycle throws, a runtime failure like any other) — or how it failed: `deadline`
 *  once RUN_DEADLINE_MS has passed, whichever side gave up first (this wait, the loaded `run()`, or a
 *  redirect's own runner), else `runtime`. The value is RELEASED once serialized, whenever it lands:
 *  a Workers-RPC result holds its callee open until disposed, and a returned live value (a function,
 *  a handle) holds this context with it. The value only, never also its promise: they share one
 *  disposer, and a second call throws. */
export async function runSettlementOf(execution: Promise<unknown>): Promise<RunSettlement> {
  const startedAt = Date.now();
  try {
    const json = await withTimeout(
      execution.then((value) => {
        try {
          return JSON.stringify(value);
        } finally {
          // Any value may carry a disposer (an RPC result, a stub); a primitive or plain data has none.
          // A disposer that throws (already released, or not ours to release) never turns the run's
          // outcome into a failure: the release is housekeeping, the settlement is the fact.
          try {
            (value as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
          } catch {
            /* already released or not ours */
          }
        }
      }),
      RUN_DEADLINE_MS,
      "itx.run",
    );
    // `json` is absent only for a value JSON has no text for (undefined, a function): the log then
    // carries no result. (An empty STRING result serializes to `""`, two chars — truthy.)
    return { status: "succeeded", result: json ? JSON.parse(json) : undefined };
  } catch (error) {
    if (Date.now() - startedAt >= RUN_DEADLINE_MS)
      return {
        status: "failed",
        error: `itx.run: the script did not finish within ${RUN_DEADLINE_MS / 60_000} minutes; it may have partly run, and it is not run again`,
        failureKind: "deadline",
      };
    return {
      status: "failed",
      error: String(error instanceof Error ? error.message : error).slice(0, 8_000),
      failureKind: "runtime",
    };
  }
}

/** `script` is wire-fed (`itx.run` over capnweb; the array-form expression carries no argument
 *  validation), so it is typed `unknown` here and the runtime check IS the contract — `LibraryRoots.run`
 *  keeps the `string` signature callers see. */
export async function runScript(itx: LibraryItx, script: unknown): Promise<unknown> {
  if (typeof script !== "string" || !script.trim())
    throw new Error("itx.run(script): script is the text of a function, `async (itx) => { … }`");
  // The request and the wait are the KERNEL's own log traffic, spelled at the fixed point: a context's
  // rows say what its code may spell, never whether the runner may write its request (a jail's bare
  // null must not wall the platform's own plumbing).
  const [requested] = await itx.builtins.append({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: script },
  });
  const requestOffset = requested!.offset; // the run's identity: its settlement names it
  // The runner started at that commit and settles by the deadline. Wait for ITS settlement: each
  // wait is capped (stream.ts), so re-arm on timeout from the last event seen — a settlement of
  // another run in between is skipped, not lost — until a minute past the deadline, time for the
  // settlement's own append. None by then means the runner could not record one (it reports why):
  // give up rather than hold the caller's call, and this context with it, open.
  const waitUntil = Date.now() + RUN_DEADLINE_MS + 60_000;
  let afterOffset = requestOffset;
  for (;;) {
    let settled;
    try {
      settled = await itx.builtins.waitForEvent({
        type: "events.iterate.com/itx/run-settled",
        afterOffset,
        timeoutMs: Math.min(120_000, Math.max(0, waitUntil - Date.now())),
      });
    } catch (error) {
      if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
      if (Date.now() >= waitUntil)
        throw codedError(
          "WAIT_TIMEOUT",
          `itx.run: no settlement of run ${requestOffset} within ${(RUN_DEADLINE_MS + 60_000) / 60_000} minutes`,
        );
      continue;
    }
    afterOffset = settled.offset;
    // Validated at the append boundary against CoreContract's schema (core-processor.ts), so the
    // payload IS a RunSettled: read as such, never re-parsed — the library takes only itx, and the
    // contract's TYPE is free to import where its runtime is not (library.test.ts, the boundary).
    const { requestOffset: settledOffset, settlement } = settled.payload as RunSettled;
    if (settledOffset !== requestOffset) continue;
    if (settlement.status === "succeeded") return settlement.result;
    throw Object.assign(new Error(settlement.error), { failureKind: settlement.failureKind });
  }
}

// ── the entities ── `itx.repos`, `itx.workspaces`: a repo (src/repo/) and a workspace
// (src/workspace/) are each a FACET hosted on their own context, and ONE
// SHAPE here. `get(path)` is the HANDLE — pure addressing: a first-party facet is hosted on its first
// call and addressed after (the DO's startup memo), so nothing is appended to get one; every call on
// the handle is one dotted expression on that facet, run in the sibling under ITS rules (a test lends
// a fake `itx.cfArtifacts` on a repo's context) — EXCEPT `append(...events)`, THE TYPED WRITE: the
// entity's own events, each validated against its contract and appended on the context at `path`
// under the CALLER's principal, never through the facet (a facet's appends are the processor's,
// stamped as its). `list()` and `create(path)` are THE COLLECTION's, which lives where the catalog
// does: the `project` facet on `/` (src/project/durable-object.ts carries one
// `EntityCollectionRpcTarget` per entity, src/project/collection.ts) — `list()` reads the catalog
// the project processor folds from the cross-posted certificates; `create(path)` is the creation
// saga on the path: the processor row, `<entity>/create-requested`, then `<entity>/created`
// (cross-posted to `/` by the entity's processor, which provisions at head from state) or
// `<entity>/create-failed`, thrown.

/** The context a handle's relative paths mean, and a creation's CREATOR: the caller's originating
 *  context (`Caller.path`, stamped by the first hop — `./x` from a child, answered at the root
 *  through its link, is the child's `./x`), else this one (`ownPath`). */
const originOf = (caller: Caller, ownPath: string): string => caller.path || ownPath;

/** An entity root is ONE shape: `get(path)` the handle (`entityHandle`, typed as the facet it
 *  dispatches to — the note above `entityHandle` says why the assertion is safe), `list()`,
 *  `create(path)` and `delete(path)` one dispatch each on the collection the `project` facet carries
 *  (`projectFacet`): the platform's own `EntityCollectionRpcTarget`, whose verbs answer exactly
 *  these shapes — ours, so the wire's copy is asserted, not re-validated. */
function entityRoot<Handle>(
  itx: LibraryItx,
  deps: LibraryDeps,
  name: "repo" | "workspace",
  contract: EntityContract,
): EntityRoot<Handle> {
  const collection = `${name}s` as const;
  return {
    get: (path) =>
      entityHandle(itx, path, name, contract, deps.caller(), deps.path) as InvokeHandle & Handle,
    list: () =>
      projectFacet(itx, [[collection], ["list"]]) as Promise<{ path: string; createdAt: string }[]>,
    // THE CREATION, from the caller's context: the path resolved against it, and the CREATOR — the
    // caller's originating context, which the platform stamped, never an argument. The collection's
    // saga on the `project` facet writes the parent link `itx ⇒ itx.builtins.cd(creator)` on the new
    // context with `<entity>/create-requested`, before the certificate (itx-expression-rewriting.ts
    // rule 3: everything the new context does not claim, its creator answers). A created entity
    // answers at once, and nothing re-points it.
    create: async (path) => {
      const creator = originOf(deps.caller(), deps.path);
      const absolute = resolveContextPath(creator, path);
      // A context never creates its own ancestor: the link it would write there points back down at
      // itself — a two-context cycle — and a child never holds more than its creator.
      if (creator !== absolute && creator.startsWith(absolute === "/" ? "/" : `${absolute}/`))
        throw codedError(
          "FORBIDDEN",
          `${collection}.create(${JSON.stringify(path)}) from ${JSON.stringify(creator)}: a context does not create its own ancestor`,
        );
      return projectFacet(itx, [[collection], ["create", absolute, { creator }]]) as Promise<{
        path: string;
      }>;
    },
    delete: async (path) =>
      projectFacet(itx, [
        [collection],
        ["delete", resolveContextPath(originOf(deps.caller(), deps.path), path)],
      ]) as Promise<{ path: string }>,
  };
}

// THE LIBRARY'S HOPS ARE ADDRESSING, spelled at the fixed point (`itx.builtins.cd`): a physical grant
// at a jailed context (`itx.repos ⇒ itx.builtins.repos` beside the bare `null`) runs these verbs
// THERE, where `itx.cd` is masked — the verbs must still reach the entity's context and the catalog
// at `/`. What a context may reach OF the library its table says; how the library gets there is not
// the table's business (the same rule as the runner's own log traffic, below).

/** ONE dispatch on the `project` facet at `/` — the catalog host, where the collections live. */
async function projectFacet(itx: LibraryItx, steps: ItxExpression): Promise<unknown> {
  // TWO dotted calls, never one chain (the `run` section says why): the root's handle first —
  // in-process a VALUE — then the facet chain relative to it.
  const context = await itx.builtins.cd("/");
  return context.invoke(["facets", ["get", "project"], ...steps]);
}

/** What `entityHandle` reads off a contract: the payload schema of an event type it owns, or none. */
type EntityContract = { payloadSchemaFor?: (type: string) => z.ZodType | undefined };

// An InvokeHandle's dotted members are DYNAMIC (expression.ts: every unknown member reduces to one
// dispatch), so a handle types as the facet it dispatches to — the first-party class the name hosts
// — by assertion at the root (`InvokeHandle & RepoFacet` says what `handle.readFile(…)` lands on),
// which the runtime guarantees (first-party-facets.ts: the name IS that class) and the type system
// cannot see.

/** The `name` facet on the context at `path`, and the typed write of `contract`'s events there: a
 *  first step `["append", ...events]` with nothing after it validates each event's payload against
 *  the contract (a type the contract does not own is refused, naming both) and appends the parsed
 *  events on the context — the caller's principal on every one; any other chain is one dispatch on
 *  the facet. */
function entityHandle(
  itx: LibraryItx,
  path: string,
  name: string,
  contract: EntityContract,
  caller: Caller,
  ownPath: string,
): InvokeHandle {
  return new InvokeHandle(async (itxExpressionSteps) => {
    // TWO dotted calls, never one chain (the `run` section says why): the sibling's handle first —
    // in-process a VALUE — then the chain relative to it. The path means the CALLER's `./x`.
    const context = await itx.builtins.cd(resolveContextPath(originOf(caller, ownPath), path));
    const [first, ...rest] = itxExpressionSteps;
    if (Array.isArray(first) && first[0] === "append" && rest.length === 0) {
      const [, ...events] = first;
      const parsed = events.map((event) => {
        // Wire-fed (a handle's steps carry no validation): the shape is checked here, then the
        // payload by the contract's own schema — the runtime check IS the contract.
        const input = z
          .object({
            type: z.string(),
            payload: z.unknown(),
            idempotencyKey: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            ephemeral: z.literal(true).optional(),
          })
          .parse(event);
        const schema = contract.payloadSchemaFor?.(input.type);
        if (!schema)
          throw new Error(
            `${name}.append: ${JSON.stringify(input.type)} is not an event the ${name} contract owns`,
          );
        return { ...input, payload: schema.parse(input.payload ?? {}) };
      });
      return context.invoke([["append", ...parsed]]);
    }
    return context.invoke(["facets", ["get", name], ...itxExpressionSteps]);
  });
}

// ── the files ── `itx.files.get(path)`: the path's object in `itx.r2` (already the owner's slice),
// the key being the path without its leading slash, so `itx.r2.list()` shows the same objects.

/** A file path's R2 key: leading slash off (a prefix may be empty). */
const fileKey = (path: string): string => path.replace(/^\/+/, "");

/** `put`'s data as bytes: bytes as they are; a string is base64, with or without a `data:` prefix
 *  (a string is never raw text). A `data:` URL's own content type wins. */
function fileBytes(data: Uint8Array | ArrayBuffer | string): {
  bytes: Uint8Array;
  contentType?: string;
} {
  if (typeof data !== "string")
    return { bytes: data instanceof Uint8Array ? data : new Uint8Array(data) };
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(data);
  const base64 = dataUrl ? dataUrl[2]! : data;
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, ...(dataUrl?.[1] && { contentType: dataUrl[1] }) };
}

/** A stored object as a file record: its key as a path, its content type from the HTTP metadata. */
const fileRecord = (object: {
  key: string;
  size: number;
  httpMetadata: { contentType?: string };
}): FileRecord => ({
  path: `/${object.key}`,
  contentType: object.httpMetadata.contentType || "application/octet-stream",
  size: object.size,
});

/** The file at `path`: every dotted member is one of the handle's verbs over `itx.r2`. */
function fileHandle(itx: LibraryItx, path: string): InvokeHandle & FileHandle {
  const key = fileKey(path);
  const verbs: FileHandle = {
    put: async (input) => {
      const { bytes, contentType } = fileBytes(input.data);
      return fileRecord(
        await itx.r2.put(key, bytes, {
          httpMetadata: {
            contentType: input.contentType || contentType || "application/octet-stream",
          },
        }),
      );
    },
    bytes: async () => {
      const object = await itx.r2.get(key);
      if (!object) throw new Error(`files: nothing at "/${key}"`);
      return object.data;
    },
    head: async () => {
      const object = await itx.r2.head(key);
      return object ? fileRecord(object) : null;
    },
    delete: () => itx.r2.delete(key),
    url: (input = {}) => itx.r2.presign({ key, ...input }),
  };
  return new InvokeHandle(async (itxExpressionSteps) => {
    const [step, ...rest] = itxExpressionSteps;
    if (rest.length > 0 || !Array.isArray(step) || !(step[0] in verbs))
      throw new Error(
        `files.get(path): one of put({ contentType, data }) · bytes() · head() · delete() · url({ method?, expiresInSeconds? }), got ${print(itxExpressionSteps)}`,
      );
    const [verb, ...args] = step as [keyof FileHandle, ...unknown[]];
    // The verb's argument is wire-fed (an InvokeHandle's steps carry no validation); each verb
    // reads what it needs and the runtime checks in fileBytes are the contract.
    return (verbs[verb] as (...verbArgs: unknown[]) => unknown)(...args);
  }) as InvokeHandle & FileHandle;
}
