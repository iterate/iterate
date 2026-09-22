// library.ts — THE LIBRARY: the built-ins that could be userspace, ONE file the boundary test reads
// whole. Five concepts:
//   the library — `buildLibrary` (the memoized roots) + the rule, and the two refusal helpers
//   run         — `itx.run(script)`: the text of `async (itx) => …`, requested on the log (`context/run-requested`), run by the context's runner, its settlement awaited
//   capnweb     — `itx.connectToCapnweb(url)`: a remote capnweb API as a pipelinable handle
//   mcp         — `itx.connectToMcp(url)`: an MCP client over Streamable HTTP
//   openapi     — `itx.connectToOpenApi(spec)`: an OpenAPI 3 service as an RpcTarget of operationIds
//   repos       — `itx.repos.get(path)` / `.list()` / `.create(path)`: a repo as a stream on any path — its `repo` facet
//   workspaces  — `itx.workspaces.get(path)` / `.list()` / `.create(path)`: the workspace of any context — its `workspace` facet
//   agents      — `itx.agents.get(path)` / `.list()` / `.create(path)`: an agent on any path — its `agent` facet, the loop that acts by scripts
//   files       — `itx.files.get(path)` / `.list()`: project file storage — a path, its bytes and content type, over `itx.r2`

import {
  RpcSession,
  newWebSocketRpcSession,
  type RpcStub,
  type RpcTransport,
  RpcTarget,
} from "capnweb";
import { z } from "zod";
import {
  keySortedForPrint,
  InvokeHandle,
  print,
  walkStepsOnRpcStub,
  type ItxExpression,
} from "iterate/next/expression";
import { codedError, errorCode, resolveContextPath } from "iterate/next/lib";
import type { Caller } from "iterate/next/principal";
import type { EventInput, StreamEvent } from "iterate/next/stream/processor";
import type { RunSettled } from "./stream/core-processor.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
import { AgentContract } from "./agent/contract.ts";
import type { AgentDurableObject } from "./agent/durable-object.ts";
import { RepoContract } from "./repo/contract.ts";
import type { RepoDurableObject } from "./repo/durable-object.ts";
import { WorkspaceContract } from "./workspace/contract.ts";
import type { WorkspaceDurableObject } from "./workspace/durable-object.ts";

// ── the library ── THE LIBRARY: the built-ins that could be userspace. context/built-ins.ts has TWO
// groups: ROOTS, implemented against ctx/env (the log, the stub registry, the rule table, the two
// hosts, the bindings), and THIS FILE — plain compiled-in first-party code whose ONLY dependency is
// `itx`, the same dotted handle a loaded worker gets from `env.ITX.get()`. That signature IS the
// layering (the owner's litmus test: "could this be written in a userspace worker?"): a library module
// takes `itx` and nothing else, so it could move to a userspace worker unchanged (the capnweb connector once
// the SDK exports `InvokeHandle`); the surface shows no level — `itx.connectToMcp(url)` reads like
// `itx.ai.run(...)` — the file and the signature do. library.test.ts pins the rule (no runtime import
// from the stream, the DO or the context folder, except context/expression.ts — the codec and the
// pipelinable handle).
//
// The verbs: `run` · `connectToMcp` · `connectToOpenApi` · `connectToCapnweb` · `repos.get`/`list`/`create`/`delete` ·
// `workspaces.get`/`list`/`create`/`delete` · `agents.get`/`list`/`create`/`delete` · `files.get`/`list`. `run` is sugar over
// `itx.workers.get` (the run section); an entity's `get(path)` is a handle over `itx.cd(path).facets.get`,
// its `list()` and `create(path)` one dispatch on the collection the `project` facet on `/` carries
// (the entities section). The three connectors each
// return a connection RpcTarget a caller can hold across calls, and each does ALL its HTTP through
// `itx.fetch` (egress: `getSecret("/secrets/NAME")` placeholders in headers substitute for free; a user
// rule shadowing `itx.fetch` redirects the library too, which is how a test fakes a remote). The
// other direction — this deployment as an MCP server — is not a library member: the control plane
// serves ONE `/mcp` for every project (control-plane.ts).
//
// LIVE CONNECTIONS ARE MEMOIZED per context: a connector reached THROUGH a rewrite rule
// (`provide('itx.tools', "itx.connectToMcp(url)")`, the documented composition) is a connect per
// call as an expression — a fresh MCP session, an open WebSocket, that no intermediate holder ever
// disposes. So `buildLibrary` keeps every connection it opened, by (verb, url, options), hands the
// same one back while it lives, and `releaseConnections()` closes them all — the context's pins'
// release calls it beside returning its borrowed stubs (only an open capnweb socket pins the actor:
// `holdsOpenSocket`). A connection closed by a holder or broken by the far side
// reopens itself on its next use (the mcp and capnweb sections), so a memoized one is never dead.

/** What a library module is handed: the itx handle (the record's own dotted surface), narrowed to
 *  what the library uses today — `fetch`, the connectors' HTTP; `workers`, the host `run` loads
 *  into; `cd`, the sibling a repo or workspace facet is hosted on. Widen it HERE when a module needs
 *  more of itx — never by importing something else. */
export type LibraryItx = Pick<
  BuiltInScope,
  "append" | "waitForEvent" | "fetch" | "workers" | "cd" | "r2" | "builtins"
>;

/** The library's roots, exactly as the built-ins record spreads them in: each verb closed over ONE
 *  `itx`. `BuiltInScope` (context/built-ins.ts) extends this, so the typed surface has them once. */
export interface LibraryRoots {
  /** A script — the text of `async (itx) => { … }` — run ONCE against this context, ON THE LOG:
   *  `run` appends `context/run-requested { code }` (attributed to the caller), the context's
   *  runner starts it at that commit in a confined isolate (`executeScript`: a WorkerEntrypoint
   *  whose `run` hands the script `env.ITX.get()`), and `run` resolves with the `run-settled`
   *  event's result — or rejects with its error. So every script that ever ran is a pair of events
   *  on the context it ran against, and a run the context's restart interrupted is settled as such,
   *  never re-run. JSON in, JSON out. A script bakes in its own values — an agent writes it whole
   *  (an alternative to a tool call), so `run` takes no arguments. */
  run(script: string): Promise<unknown>;
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
  /** THE REPOS (src/repo/): a repo as a DOMAIN OBJECT — a stream on ANY path (`/repos/<name>` by
   *  convention) whose `repo` facet lands the commit facts and memoizes the tip — git spoken from
   *  inside the facet, its token and remote from `itx.cfArtifacts` (which derives the Artifacts
   *  repo's name from the path). `create(path)` is THE CREATION, the collection's (src/project/collection.ts,
   *  on the `project` facet at `/`): the `repo` processor row on the path, `repo/create-requested`,
   *  then the terminal fact — `repo/created`, cross-posted to `/` by the repo processor, or
   *  `repo/create-failed`, thrown. `get(path)` is the handle — pure addressing, hosted on its first
   *  call: the facet's verbs (`RepoDurableObject`'s `tip` `readFile` `readModules` `modules` `listFiles`
   *  `commitFiles` `writeFile` `log`, each one dotted expression on the facet, refused until the certificate has
   *  landed) plus the typed `append(...events)` — the repo's own events, validated against its
   *  contract, appended on that context under the caller. `list()` is the project catalog: the
   *  certificates cross-posted to `/`, folded by the project processor (src/project/). */
  repos: {
    get(path: string): InvokeHandle & RepoFacet;
    list(): Promise<{ path: string; createdAt: string }[]>;
    create(path: string): Promise<{ path: string }>;
    /** The entity's deletion saga on that path: the request, the death certificate (cross-posted to `/`, the catalog drops it), then the row disabled. */
    delete(path: string): Promise<{ path: string }>;
  };
  /** THE WORKSPACES (src/workspace/): the workspace of ANY context, at most one per path — a
   *  workspace IS its path. `create(path)` is the collection's (src/project/collection.ts): the
   *  `workspace` processor row on the path, `workspace/create-requested`, then `workspace/created`
   *  (cross-posted to `/` by the workspace processor) or `workspace/create-failed`, thrown.
   *  `get(path)` is the `workspace` facet on `itx.cd(path)`, hosted on its first call and addressed
   *  after — its methods (`WorkspaceDurableObject`'s `readFile` `readBase` `writeFile` `deleteFile`
   *  `revert` `listAllFiles` `mounts` `gitStatus` `gitCommit` `gitLog`, each one dotted expression
   *  on that facet, refused until the certificate has landed) plus the typed `append`. `list()` is
   *  the project catalog (as for repos). */
  workspaces: {
    get(path: string): InvokeHandle & WorkspaceFacet;
    list(): Promise<{ path: string; createdAt: string }[]>;
    create(path: string): Promise<{ path: string }>;
    /** The entity's deletion saga on that path: the request, the death certificate (cross-posted to `/`, the catalog drops it), then the row disabled. */
    delete(path: string): Promise<{ path: string }>;
  };
  /** THE AGENTS (src/agent/): an agent as a DOMAIN OBJECT — a conversation on the context at ANY
   *  path (`/agents/<name>` by convention), driven by a model that acts by writing scripts against
   *  that context's `itx`; apps/os's agent, lean. `create(path)` is the collection's
   *  (src/project/collection.ts): the `agent` processor row on the path (the loop runs on every
   *  commit), `agent/create-requested`, then `agent/created` (cross-posted to `/` by the agent
   *  processor) or `agent/create-failed`, thrown; an operator prompt is a keyed
   *  `agent/context-added` through the handle's `append`. `get(path)` is the `agent` facet there,
   *  hosted on its first call and addressed after: `message(text)` is a person's words, the trigger
   *  of a turn, and `append(...events)` the typed write of the agent's own events; everything the
   *  loop does is an event on the path. `list()` is the project catalog: every `agent/created`
   *  cross-posted to `/`, folded by the project processor (src/project/) — a userspace agent that
   *  announces itself lists the same. */
  agents: {
    get(path: string): InvokeHandle & AgentFacet;
    list(): Promise<{ path: string; createdAt: string }[]>;
    create(path: string): Promise<{ path: string }>;
    /** The entity's deletion saga on that path: the request, the death certificate (cross-posted to `/`, the catalog drops it), then the row disabled. */
    delete(path: string): Promise<{ path: string }>;
  };
  /** THE FILES (apps/os's `itx.files`, lean): project file storage as a PATH namespace over `itx.r2`
   *  — a file is its path (leading slash), its bytes and a content type; last write wins, no
   *  events. `get(path)` is a handle: `.put({ contentType, data })` (data: bytes, or a string that
   *  is base64 or a `data:` URL) → the record, `.bytes()`, `.head()` (null when absent), `.delete()`,
   *  and `.url({ method?, expiresInSeconds? })` — a signed URL on the project host that downloads
   *  (`GET`, the default) or uploads (`PUT`) the file, `itx.r2.presign` underneath. `list(prefix?)`
   *  is what apps/os lacks and an agent needs: the records under a prefix. */
  files: {
    get(path: string): InvokeHandle & FileHandle;
    list(prefix?: string): Promise<FileRecord[]>;
  };
}

/** A stored file as `itx.files` answers it: its path, content type and size. */
export type FileRecord = { path: string; contentType: string; size: number };
/** What a file handle's dotted members reach. */
export type FileHandle = {
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

/** What a repo handle's dotted members reach: the repo facet's own methods, and the typed `append`
 *  of the repo's events on that context (`entityHandle`). */
export type RepoFacet = Pick<
  RepoDurableObject,
  "tip" | "readFile" | "readModules" | "modules" | "listFiles" | "commitFiles" | "writeFile" | "log"
> & { append(...events: EventInput<typeof RepoContract>[]): Promise<StreamEvent[]> };
/** What an agent handle's dotted members reach: the agent facet's own methods, and the typed
 *  `append` of the agent's events on that context. */
export type AgentFacet = Pick<AgentDurableObject, "message"> & {
  append(...events: EventInput<typeof AgentContract>[]): Promise<StreamEvent[]>;
};
/** What a workspace handle's dotted members reach: the workspace facet's own methods, and the typed
 *  `append` of the workspace's events on that context. */
export type WorkspaceFacet = Pick<
  WorkspaceDurableObject,
  | "mounts"
  | "readFile"
  | "readBase"
  | "writeFile"
  | "deleteFile"
  | "revert"
  | "listAllFiles"
  | "gitStatus"
  | "gitCommit"
  | "gitLog"
> & { append(...events: EventInput<typeof WorkspaceContract>[]): Promise<StreamEvent[]> };

/** The library, built once per context: the verbs closed over one `itx`, memoizing the live
 *  connections the connectors open, and the one release door. Nothing is constructed here: a wake
 *  pays nothing for the library until a verb runs. */
export function buildLibrary(
  itx: LibraryItx,
  deps: {
    /** WHO is calling right now — read when a handle is MADE (a handle is a value that outlives the
     *  call; its later dispatches arrive with no ambient caller), so a relative path (`./x` from a
     *  child, answered at the root through its link) means the caller's, and a creation's parent
     *  link names the caller's context. */
    caller: () => Caller;
    /** This context's path — a relative path's base when the caller carries none. */
    path: string;
  },
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
      // An entity root is ONE shape: `get(path)` the handle (`entityHandle`, typed as the facet it
      // dispatches to — the entities section says why the assertion is safe), `list()` and
      // `create(path)` one dispatch each on the collection the `project` facet carries
      // (`projectFacet`): the platform's own `EntityCollectionRpcTarget`, whose `list` and
      // `create` answer exactly these shapes — ours, so the wire's copy is asserted, not re-validated.
      repos: {
        get: (path) =>
          entityHandle(itx, path, "repo", RepoContract, deps.caller(), deps.path) as InvokeHandle &
            RepoFacet,
        list: () =>
          projectFacet(itx, [["repos"], ["list"]]) as Promise<
            { path: string; createdAt: string }[]
          >,
        create: (path) => createEntity(itx, path, "repos", deps.caller(), deps.path),
        delete: async (path) =>
          projectFacet(itx, [
            ["repos"],
            ["delete", resolveContextPath(originOf(deps.caller(), deps.path), path)],
          ]) as Promise<{ path: string }>,
      },
      workspaces: {
        get: (path) =>
          entityHandle(
            itx,
            path,
            "workspace",
            WorkspaceContract,
            deps.caller(),
            deps.path,
          ) as InvokeHandle & WorkspaceFacet,
        list: () =>
          projectFacet(itx, [["workspaces"], ["list"]]) as Promise<
            { path: string; createdAt: string }[]
          >,
        create: (path) => createEntity(itx, path, "workspaces", deps.caller(), deps.path),
        delete: async (path) =>
          projectFacet(itx, [
            ["workspaces"],
            ["delete", resolveContextPath(originOf(deps.caller(), deps.path), path)],
          ]) as Promise<{ path: string }>,
      },
      agents: {
        get: (path) =>
          entityHandle(
            itx,
            path,
            "agent",
            AgentContract,
            deps.caller(),
            deps.path,
          ) as InvokeHandle & AgentFacet,
        list: () =>
          projectFacet(itx, [["agents"], ["list"]]) as Promise<
            { path: string; createdAt: string }[]
          >,
        create: (path) => createEntity(itx, path, "agents", deps.caller(), deps.path),
        delete: async (path) =>
          projectFacet(itx, [
            ["agents"],
            ["delete", resolveContextPath(originOf(deps.caller(), deps.path), path)],
          ]) as Promise<{ path: string }>,
      },
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
      // that throws is REPORTED — a connection that will not close is a fact worth a log line.
      for (const [memoKey, { connection }] of liveConnections)
        void connection
          .then((c) => {
            const held = c as { close?: () => unknown; [Symbol.dispose]?: () => void };
            return held.close ? held.close() : held[Symbol.dispose]?.();
          })
          .catch((error: unknown) =>
            console.warn(`releaseConnections: ${memoKey} did not close: ${String(error)}`),
          );
      liveConnections.clear();
    },
  };
}

// ── run ── `itx.run(script)`: a request on the log, its settlement awaited. `runScript` appends
// `context/run-requested` and waits for the `run-settled` naming that request's offset; the EXECUTION is the
// context DO's runner (iterate-context-durable-object.ts `#executeRun`), which calls `executeScript`
// below at the request's commit — so a literal `run-requested` appended by anyone (a client over
// /api, the agent's loop, a schedule) runs exactly as `itx.run` does, and both leave the same pair
// of events. The script is the text of a function of one parameter — `async (itx) => …` — spliced
// VERBATIM into the template below (a caller's own code in its own confined isolate: the
// trusted-client doctrine), so a text that is not one function expression fails at load, in the
// loader's words. It takes no arguments: a script is an agent's whole output (an alternative to a
// tool call), its values baked in. The template is the smallest WorkerEntrypoint that hosts it:
// `run()` mints the itx scope for the call and disposes it after, as the SDK's ConfigWorker does.
// The call rides `itx.workers.get(...).run()` on the handle the library holds, so a rule on
// `itx.workers` applies to it like any other call.

/** The module `run` loads: `script` spliced in as `const script = (…)`. Exported for the unit pin. */
export function runScriptModule(script: string): { "cap.js": string } {
  return {
    "cap.js": [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      `const script = (${script});`,
      "export default class extends WorkerEntrypoint {",
      "  async run() {",
      "    const itx = this.env.ITX.get();",
      "    try {",
      "      return await script(itx);",
      "    } finally {",
      "      itx[Symbol.dispose]?.();",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
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

/** `script` is wire-fed (`itx.run` over capnweb; the array-form expression carries no argument
 *  validation), so it is typed `unknown` here and the runtime check IS the contract — `LibraryRoots.run`
 *  keeps the `string` signature callers see. */
export function runScript(itx: LibraryItx, script: unknown): Promise<unknown> {
  if (typeof script !== "string" || !script.trim())
    throw new Error("itx.run(script): script is the text of a function, `async (itx) => { … }`");
  return requestAndAwaitRun(itx, script);
}

async function requestAndAwaitRun(itx: LibraryItx, script: string): Promise<unknown> {
  // The request and the wait are the KERNEL's own log traffic, spelled at the fixed point: a context's
  // rows say what its code may spell, never whether the runner may write its request (a jail's bare
  // null must not wall the platform's own plumbing).
  const [requested] = await itx.builtins.append({
    type: "events.iterate.com/context/run-requested",
    payload: { code: script },
  });
  const requestOffset = requested!.offset; // the run's identity: its settlement names it
  // The runner started at that commit. Wait for ITS settlement — as long as the script takes: the
  // caller's own call holds the context, and each wait is capped (stream.ts), so re-arm on timeout
  // from the last event seen; a settlement of another run in between is skipped, not lost.
  let afterOffset = requestOffset;
  for (;;) {
    let settled;
    try {
      settled = await itx.builtins.waitForEvent({
        type: "events.iterate.com/context/run-settled",
        afterOffset,
        timeoutMs: 120_000,
      });
    } catch (error) {
      if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
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

// ── the entities ── `itx.repos`, `itx.workspaces`, `itx.agents`: a repo (src/repo/), a workspace
// (src/workspace/) and an agent (src/agent/) are each a FACET hosted on their own context, and ONE
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

/** THE CREATION, from the caller's context: the path resolved against it, the CREATOR named on the
 *  request — the collection's saga on the `project` facet (`<entity>/create-requested { creator }` …
 *  `created`) writes the parent link `itx ⇒ itx.builtins.cd(creator)` on the new context before the
 *  certificate (itx-expression-rewriting.ts rule 3: everything the new context does not claim, its
 *  creator answers). A created entity answers at once, and nothing re-points it. */
async function createEntity(
  itx: LibraryItx,
  path: string,
  collection: "repos" | "workspaces" | "agents",
  caller: Caller,
  ownPath: string,
): Promise<{ path: string }> {
  const creator = originOf(caller, ownPath);
  const absolute = resolveContextPath(creator, path);
  // A context never creates its own ancestor: the link it would write there points back down at
  // itself — a two-context cycle — and a child never holds more than its creator.
  if (creator !== absolute && creator.startsWith(absolute === "/" ? "/" : `${absolute}/`))
    throw codedError(
      "FORBIDDEN",
      `${collection}.create(${JSON.stringify(path)}) from ${JSON.stringify(creator)}: a context does not create its own ancestor`,
    );
  // The creator rides the request: the entity's saga writes the parent link before the certificate.
  return projectFacet(itx, [[collection], ["create", absolute, { creator }]]) as Promise<{
    path: string;
  }>;
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
 *  (apps/os's FileData rule — a string is never raw text). A `data:` URL's own content type wins. */
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

/** The error for a response that refused: `<what> returned <status>: <the first 300 characters>`.
 *  The body is read only that far, then CANCELLED — a refusal's snippet must never buffer a whole
 *  error page (the v4 review's hygiene item). */
export async function responseRefusal(response: Response, what: string): Promise<Error> {
  const reader = response.body?.getReader();
  let snippet = "";
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (snippet.length < 300) {
        const { done, value } = await reader.read();
        if (done) break;
        snippet += decoder.decode(value, { stream: true });
      }
    } catch {
      /* a body that cannot be read adds nothing to the refusal */
    } finally {
      reader.cancel().catch(() => undefined);
    }
    snippet = snippet.slice(0, 300);
  }
  return new Error(`${what} returned ${response.status}${snippet ? `: ${snippet}` : ""}`);
}

/** The response, or the refusal thrown — ONE spelling for every non-2xx the connectors meet. */
export async function refuseUnlessOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  throw await responseRefusal(response, what);
}

// ── capnweb ── `itx.connectToCapnweb(url, { headers?, transport? })`: a remote capnweb API's
// main object as a pipelinable handle, written against `itx.fetch` alone (the library rule, above).
// The WebSocket is opened THROUGH egress — `itx.fetch` with the Upgrade header, the 101's socket
// accepted and handed to capnweb — so `getSecret("/secrets/NAME")` headers substitute and the socket is
// the context's. `{ transport: "batch" }` is the one-shot alternative: capnweb's HTTP batch client
// uses the global fetch, so the same transport is re-spelled here over `itx.fetch` (RpcTransport is
// capnweb's own extension point for exactly that). A held connection pins this context awake for its
// life, like a busy facet; dispose it and the session closes. A batch connection holds no socket:
// each chain is its own batch session, so it never pins anything.

/** The remote main object: unknown by construction — the caller's dotted calls are its contract. */
type RemoteMain = RpcStub<any>;

/** Options for `connectToCapnweb`: headers for the handshake (auth), and the transport — a WebSocket
 *  session (default) or one HTTP batch per call chain. */
export type CapnwebConnectOptions = {
  headers?: Record<string, string>;
  transport?: "websocket" | "batch";
};

/** Connect and hand back the remote main object as a handle. A WebSocket session is opened now and
 *  shared by every later call; the batch transport opens one capnweb batch session PER CHAIN (a
 *  batch is one POST and dies with it — capnweb's own contract), which is the one-shot shape. */
export async function connectToCapnweb(
  itx: LibraryItx,
  url: string,
  options: CapnwebConnectOptions = {},
): Promise<CapnwebConnection> {
  const headers = options.headers || {};
  if (options.transport === "batch")
    return new CapnwebConnection(
      () => batchSessionOverEgress(itx, url, headers),
      () => undefined,
    );
  // The WebSocket session is opened NOW (a connect that cannot reach the far side fails here) and
  // REOPENED on the next call after it is gone — disposed (the context's pins' release closes every
  // library connection, index.ts) or broken by the far side — so a held or memoized connection is
  // never a dead socket.
  type SessionStub = RemoteMain & { onRpcBroken?: (cb: () => void) => void };
  let session: SessionStub | undefined;
  /** ONE reopen in flight at a time: concurrent calls after the session is gone share it (each
   *  opening its own would leak every socket but the last one assigned). */
  let reopening: Promise<SessionStub> | undefined;
  /** Bumped by close: a reopen that lands after a close disposes what it opened instead of reviving. */
  let generation = 0;
  const dispose = (stub: SessionStub | undefined) =>
    (stub as unknown as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  const open = async (): Promise<SessionStub> => {
    const stub = (await webSocketSessionOverEgress(itx, url, headers)) as SessionStub;
    stub.onRpcBroken?.(() => {
      if (session === stub) session = undefined;
    });
    return stub;
  };
  const reopen = async (): Promise<SessionStub> => {
    const startedIn = generation;
    try {
      const opened = await open();
      if (startedIn !== generation) {
        dispose(opened);
        throw new Error("capnweb connection closed while it was reconnecting");
      }
      session = opened;
      return opened;
    } finally {
      reopening = undefined;
    }
  };
  session = await open();
  return new CapnwebConnection(
    () => session ?? (reopening ||= reopen()),
    () => {
      generation += 1;
      const gone = session;
      session = undefined;
      dispose(gone);
    },
  );
}

/** A remote capnweb API held across calls: an InvokeHandle, so `conn.a.b(x)` reduces into one dispatch
 *  that walks the capnweb stub step by step — capnweb pipelines property access and calls, so the
 *  chain is one round trip (one WebSocket exchange, or exactly one batch POST). Disposing closes the
 *  WebSocket session (the next call reopens it); a batch connection holds nothing. */
export class CapnwebConnection extends InvokeHandle {
  readonly #closeSession: () => void;
  /** `remoteMain` answers the stub SYNCHRONOUSLY while a session is open — the walk then queues the
   *  whole chain before any batch fires or any await yields — and a promise only while a session is
   *  being (re)opened. */
  constructor(remoteMain: () => RemoteMain | Promise<RemoteMain>, closeSession: () => void) {
    super((steps) => {
      const main = remoteMain();
      return main instanceof Promise
        ? main.then((stub) => walkStepsOnRpcStub(stub, steps))
        : walkStepsOnRpcStub(main, steps);
    });
    this.#closeSession = closeSession;
  }
  /** Close the WebSocket session (the next call reopens it); a batch connection holds nothing. A
   *  DECLARED member on purpose: the dotted fallback beneath `InvokeHandle` answers every unknown
   *  name with a REMOTE path, so a probe for `close` (`releaseConnections`, the DO's release) must find this
   *  one — else it would call `close()` on the remote main and leave the local socket open. */
  close(): void {
    this.#closeSession();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

async function webSocketSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): Promise<RemoteMain> {
  const httpUrl = url.replace(/^ws(s?):/i, "http$1:");
  const response = await itx.fetch(
    new Request(httpUrl, { headers: { ...headers, upgrade: "websocket" } }),
  );
  const webSocket = response.webSocket;
  if (response.status !== 101 || !webSocket)
    throw await responseRefusal(response, `connectToCapnweb: ${url} (no WebSocket)`);
  webSocket.accept();
  return newWebSocketRpcSession(webSocket as unknown as WebSocket);
}

function batchSessionOverEgress(
  itx: LibraryItx,
  url: string,
  headers: Record<string, string>,
): RemoteMain {
  const transport = new EgressBatchTransport(async (batch) => {
    const response = await itx.fetch(
      new Request(url, { method: "POST", headers, body: batch.join("\n") }),
    );
    await refuseUnlessOk(response, `connectToCapnweb: batch to ${url}`);
    const text = await response.text();
    return text === "" ? [] : text.split("\n");
  });
  return new RpcSession(transport).getRemoteMain();
}

/** capnweb's own HTTP batch client transport, over an injected send: every message sent before the
 *  microtask queue drains rides in ONE POST; the answers are received back in order. */
class EgressBatchTransport implements RpcTransport {
  #messagesToSend: string[] | null = [];
  #abortReason: unknown;
  /** The one POST's answers, in order — settled once the macrotask after construction has run. */
  readonly #answersReceived: Promise<string[]>;
  constructor(sendBatch: (batch: string[]) => Promise<string[]>) {
    this.#answersReceived = (async () => {
      // one macrotask, so every `.then()` on the pipelined promises registers before the batch goes
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.#abortReason !== undefined) throw this.#abortReason;
      const batch = this.#messagesToSend!;
      this.#messagesToSend = null;
      return sendBatch(batch);
    })();
  }
  async send(message: string): Promise<void> {
    if (this.#messagesToSend !== null) this.#messagesToSend.push(message);
  }
  async receive(): Promise<string> {
    const received = await this.#answersReceived;
    const message = received.shift();
    // oxlint-disable-next-line iterate/simple-truthiness-check -- receive() is capnweb's RpcTransport contract: shift() returning undefined is the "batch drained" signal (throw), distinct from a frame value
    if (message === undefined) throw new Error("Batch RPC request ended.");
    return message;
  }
  abort(reason: unknown): void {
    this.#abortReason = reason;
  }
}

// ── mcp ── `itx.connectToMcp(url, { headers? })`: an MCP client over Streamable HTTP, written
// against `itx.fetch` alone (the library rule, above). JSON-RPC 2.0 POSTs to the one endpoint:
// `initialize` → `notifications/initialized` → `tools/list` at connect, then `tools/call` per call. A
// server that answers `initialize` with an `Mcp-Session-Id` header gets it back on every later request
// and a DELETE on close. Responses may be plain JSON or a `text/event-stream` carrying the JSON-RPC
// response as one `data:` event; both are read here. The shape mirrors apps/os's mcp-client.ts
// (tool args = one object; a result's `structuredContent` wins, else its text, JSON-parsed when it
// parses) without the MCP SDK: the whole client is the few requests below.

/** Options for `connectToMcp`: extra headers sent with every request (auth). */
export type McpConnectOptions = { headers?: Record<string, string> };

/** One tool as `tools/list` describes it. */
// An external MCP server's responses are UNTRUSTED network data — parsed against these schemas at
// every boundary, never cast, so a server that answers off-spec heals into a clear error instead of
// handing a typed frontend a value of the wrong shape (a tool whose `name` is a number, say).
export const MCPTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});
export type MCPTool = z.infer<typeof MCPTool>;
const MCPToolsList = z.object({ tools: z.array(MCPTool) });

/** What `initialize` answered: the server's name and version, its protocol version and capabilities. */
export const MCPServerInfo = z.object({
  protocolVersion: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
});
export type MCPServerInfo = z.infer<typeof MCPServerInfo>;

/** Connect: initialize, announce, list the tools, and hand back a connection whose prototype carries
 *  one method per tool (a tool named like one of the connection's own members — `callTool`, `close`,
 *  `then`… — is reachable through `callTool` only; index.ts `subclassWithMethods`). */
export async function connectToMcp(
  itx: LibraryItx,
  url: string,
  options: McpConnectOptions = {},
): Promise<McpConnection> {
  const client = new McpJsonRpcClient(itx, url, options.headers || {});
  const serverInfo = await client.initialize();
  try {
    const { tools } = MCPToolsList.parse(await client.request("tools/list", {}));
    const Connection = subclassWithMethods(
      McpConnection,
      tools.map((tool) => tool.name),
      (self, name, args) => self.callTool(name, args as Record<string, unknown> | undefined),
    );
    return new Connection(client, serverInfo);
  } catch (error) {
    // Discovery failed AFTER the handshake went live — close the client so its session is DELETEd
    // rather than leaked (nothing else holds this half-built connection).
    await client.close();
    throw error;
  }
}

/** A connected MCP server. Held across calls it is an RpcTarget; disposed, it DELETEs its session. */
export class McpConnection extends RpcTarget {
  readonly #jsonRpcClient: McpJsonRpcClient;
  readonly #serverInfo: MCPServerInfo;
  constructor(client: McpJsonRpcClient, serverInfo: MCPServerInfo) {
    super();
    this.#jsonRpcClient = client;
    this.#serverInfo = serverInfo;
  }
  /** The `initialize` answer. */
  serverInfo(): MCPServerInfo {
    return this.#serverInfo;
  }
  /** Ask the server again — `tools/list` now. */
  async listTools(): Promise<MCPTool[]> {
    return MCPToolsList.parse(await this.#jsonRpcClient.request("tools/list", {})).tools;
  }
  /** `tools/call`: the result's `structuredContent`, else its text content JSON-parsed when it
   *  parses, else the text; an `isError` result throws with that text. */
  async callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
    const result = MCPToolResult.parse(
      await this.#jsonRpcClient.request("tools/call", { name, arguments: args || {} }),
    );
    return mcpResultToValue(name, result);
  }
  async close(): Promise<void> {
    await this.#jsonRpcClient.close();
  }
  [Symbol.dispose](): void {
    void this.close();
  }
}

const MCPToolResult = z.object({
  // A loose content item: `type` and (for text) `text` are validated, but every OTHER field survives —
  // an image/audio/resource part keeps its `data`/`mimeType`/`resource` instead of being stripped.
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
type MCPToolResult = z.infer<typeof MCPToolResult>;

function mcpResultToValue(name: string, result: MCPToolResult): unknown {
  const text = (result.content || [])
    // oxlint-disable-next-line iterate/simple-truthiness-check -- part.text is validated string|undefined; an empty-string text part is valid MCP content and must join in, so absence (undefined) must be distinguished
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
  if (result.isError) throw new Error(`MCP tool ${name} failed: ${text || "no message"}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text === "") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type JsonRpcResponse = { id?: unknown; result?: unknown; error?: { message?: string } };

/** The JSON-RPC half: one endpoint, an id counter, the session id the server may hand out. A client
 *  closed by a holder (the context's pins' release closes the library's memoized connections)
 *  re-runs the handshake on its next request, so a held or memoized connection is never a dead
 *  session. */
class McpJsonRpcClient {
  readonly #itx: LibraryItx;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #nextId = 1;
  #sessionId: string | null = null;
  #closed = false;
  /** The in-flight handshake, shared while it runs so concurrent requests await ONE — and never post
   *  before the session id is established. Cleared on failure so the next request retries it. */
  #handshake: Promise<MCPServerInfo> | null = null;
  /** Bumped by `close()`. A handshake captures it at the start and, on completing, refuses to revive a
   *  client closed meanwhile — it DELETEs the session it just established instead of leaking it. */
  #generation = 0;
  constructor(itx: LibraryItx, url: string, headers: Record<string, string>) {
    this.#itx = itx;
    this.#url = url;
    this.#headers = headers;
  }
  /** The handshake: `initialize` → `notifications/initialized`. Memoized while in flight — a second
   *  caller (a concurrent request re-opening a closed client) joins the same one instead of racing a
   *  second handshake or posting session-less mid-handshake. `#closed` stays true until it completes. */
  async initialize(): Promise<MCPServerInfo> {
    if (!this.#handshake) {
      const handshake = this.#runHandshake();
      this.#handshake = handshake;
      // Clear the memo when THIS handshake settles — but ONLY if it is still the current one, so a
      // handshake that lost a close race never clears its replacement's memo (which would let a third
      // handshake start and leave one session unowned).
      void handshake
        .catch(() => {})
        .finally(() => {
          if (this.#handshake === handshake) this.#handshake = null;
        });
    }
    return this.#handshake;
  }
  async #runHandshake(): Promise<MCPServerInfo> {
    const generation = this.#generation;
    // This handshake OWNS the session it establishes — it never reads or writes the shared #sessionId
    // until it commits, so a concurrent handshake (a re-open racing a close) can neither clobber the
    // live session nor be clobbered by ours.
    const initialized = await this.#send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "iterate-context", version: "1" },
    });
    const sessionId = initialized.sessionId; // OUR session id, from the initialize response
    try {
      const serverInfo = MCPServerInfo.parse(initialized.result);
      await this.notify("notifications/initialized", undefined, sessionId);
      // close() (or another close) ran while this handshake was in flight: do NOT revive the client.
      if (generation !== this.#generation)
        throw new Error("MCP client was closed during its handshake");
      this.#sessionId = sessionId; // publish OUR session as the live one …
      this.#closed = false; // … and only now — session id set, initialized sent — is it usable
      return serverInfo;
    } catch (error) {
      // ANY failure once the session was allocated — a bad initialize result, a failed `initialized`
      // notify, or the close race — DELETEs OUR OWN session so the server never keeps it orphaned.
      // (Never the shared #sessionId, which a newer handshake may now own.)
      // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session established" sentinel; a server-assigned id is echoed/DELETEd verbatim, so an (off-spec) empty id must not be folded into "no session"
      if (sessionId !== null) await this.#deleteSession(sessionId);
      throw error;
    }
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) await this.initialize();
    return (await this.#send(method, params, this.#sessionId)).result;
  }
  /** Post one JSON-RPC request against `sessionId` (default: the live #sessionId) and return its
   *  result AND the session id now in effect. The handshake guard is `request`'s, so `#runHandshake`
   *  uses this directly (the guard would deadlock on its own in-flight handshake). */
  async #send(
    method: string,
    params: unknown,
    sessionId: string | null = this.#sessionId,
  ): Promise<{ result: unknown; sessionId: string | null }> {
    const id = this.#nextId++;
    const posted = await this.#post({ jsonrpc: "2.0", id, method, params }, sessionId);
    const message = await readJsonRpcResponse(posted.response, id);
    if (message.error)
      throw new Error(`MCP ${method}: ${message.error.message || JSON.stringify(message.error)}`);
    return { result: message.result, sessionId: posted.sessionId };
  }
  async notify(method: string, params: unknown, sessionId: string | null): Promise<void> {
    const { response } = await this.#post({ jsonrpc: "2.0", method, params }, sessionId);
    await response.body?.cancel();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#handshake = null; // a re-open must run a fresh handshake, not reuse this session's
    this.#generation += 1; // invalidate a handshake in flight — it must not revive this client
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session" sentinel; an (off-spec) empty session id must still be DELETEd, not treated as "nothing to delete"
    if (sessionId !== null) await this.#deleteSession(sessionId);
  }
  /** DELETE one server session (best-effort) — close()'s own, and the one a handshake that lost the
   *  close race established. */
  async #deleteSession(sessionId: string): Promise<void> {
    const headers = new Headers(this.#headers);
    headers.set("mcp-session-id", sessionId);
    await this.#itx
      .fetch(new Request(this.#url, { method: "DELETE", headers }))
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }
  /** Send `sessionId` (when set) and return the response plus the session id now in effect — the
   *  server's freshly-assigned one (initialize) or the one we sent. Does NOT touch #sessionId: the
   *  caller owns it, so a handshake that loses the close race never clobbers the live session. */
  async #post(
    body: { jsonrpc: "2.0"; id?: number; method: string; params?: unknown },
    sessionId: string | null,
  ): Promise<{ response: Response; sessionId: string | null }> {
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `null` is the deliberate "no session" sentinel; whether the mcp-session-id header is sent (even with an off-spec empty value) is a wire-level distinction, not a default
    if (sessionId !== null) headers.set("mcp-session-id", sessionId);
    const response = await this.#itx.fetch(
      new Request(this.#url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return {
      response: await refuseUnlessOk(response, `MCP ${body.method}`),
      sessionId: nextSessionId,
    };
  }
}

/** The JSON-RPC response with `id` — from a JSON body (one message or a batch array) or from a
 *  `text/event-stream` body, read AS IT ARRIVES and left the moment the event carrying that id is
 *  in (the stream is cancelled then): a server may keep the POST's stream open for later traffic
 *  (the spec says it SHOULD close it, not MUST), and waiting for its end would wait forever. */
async function readJsonRpcResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const messagesOf = (data: string): JsonRpcResponse[] => {
    const parsed = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  if (!contentType.includes("text/event-stream")) {
    const message = messagesOf(await response.text()).find((m) => m.id === id);
    if (!message) throw new Error(`MCP: no JSON-RPC response with id ${id} (${contentType})`);
    return message;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`MCP: no JSON-RPC response with id ${id} (empty event stream)`);
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffered += done ? "" : decoder.decode(value, { stream: true });
    // every complete event is a block ending in a blank line; the tail may be a partial one
    const blocks = buffered.split(/\r?\n\r?\n/);
    buffered = done ? "" : (blocks.pop() ?? "");
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data === "") continue;
      const message = messagesOf(data).find((m) => m.id === id);
      if (message) {
        await reader.cancel().catch(() => undefined);
        return message;
      }
    }
    if (done) throw new Error(`MCP: no JSON-RPC response with id ${id} (text/event-stream ended)`);
  }
}

// ── openapi ── `itx.connectToOpenApi(specOrUrl, { baseUrl?, headers? })`: an OpenAPI 3
// service as an RpcTarget whose methods are its `operationId`s, written against `itx.fetch` alone
// (the library rule, above). Deliberately small, the apps/os shape (rpc-targets.ts
// `executeOperation`): one input OBJECT per call — path parameters substitute into the path, query
// parameters go on the URL, header parameters on the request, and what is left is the JSON body
// when the operation declares one (an input whose only key is `body` sends `input.body` verbatim, for
// a non-object body). A non-2xx answer throws with the status and the first 300 characters. The base
// URL keeps the spec URL's query when it falls back to it.

/** Options for `connectToOpenApi`: `baseUrl` overrides the document's first server; `headers` ride on
 *  every operation call (and on the spec fetch only when the spec shares the API's host). */
export type OpenApiConnectOptions = { baseUrl?: string; headers?: Record<string, string> };

/** An OpenAPI 3 document — only `openapi`, `servers` and `paths` are read. */
export type OpenApiDocument = {
  openapi: string;
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, unknown>>;
};

/** One operation the connection grew a method for. */
export type OpenApiOperation = {
  operationId: string;
  method: string;
  path: string;
  parameters: Array<{ name: string; in: string; required?: boolean }>;
  hasRequestBody: boolean;
  summary?: string;
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/** Connect: fetch the document when given a URL, index its operations, and hand back a connection
 *  whose prototype carries one method per `operationId`. */
export async function connectToOpenApi(
  itx: LibraryItx,
  specOrUrl: string | OpenApiDocument,
  options: OpenApiConnectOptions = {},
): Promise<OpenApiConnection> {
  const specUrl = typeof specOrUrl === "string" ? specOrUrl : undefined;
  const spec =
    typeof specOrUrl === "string" ? await fetchDocument(itx, specOrUrl, options) : specOrUrl;
  if (typeof spec?.openapi !== "string")
    throw new Error(`connectToOpenApi: ${specUrl || "the document"} is not an OpenAPI 3 document`);
  const operations = listOperations(spec);
  const Connection = subclassWithMethods(
    OpenApiConnection,
    operations.map((operation) => operation.operationId),
    (self, name, input) => self.call(name, input as Record<string, unknown> | undefined),
  );
  return new Connection(
    itx,
    operations,
    requestBase(spec, specUrl, options),
    options.headers || {},
  );
}

/** A connected OpenAPI service. `call(operationId, input)` is the generic door; the operations are
 *  its methods too. */
export class OpenApiConnection extends RpcTarget {
  readonly #itx: LibraryItx;
  readonly #operations: Map<string, OpenApiOperation>;
  readonly #requestBaseUrl: URL;
  readonly #headers: Record<string, string>;
  constructor(
    itx: LibraryItx,
    operations: OpenApiOperation[],
    base: URL,
    headers: Record<string, string>,
  ) {
    super();
    this.#itx = itx;
    this.#operations = new Map(operations.map((operation) => [operation.operationId, operation]));
    this.#requestBaseUrl = base;
    this.#headers = headers;
  }
  /** Every operation the document declares with an `operationId`. */
  operations(): OpenApiOperation[] {
    return [...this.#operations.values()];
  }
  /** Run one operation: the input object's fields become path, query and header parameters, the
   *  rest the JSON body; the answer is JSON when the response says so, else its text. */
  async call(operationId: string, input?: Record<string, unknown>): Promise<unknown> {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error(`connectToOpenApi: no operation "${operationId}"`);
    const fields = { ...(input || {}) };
    let resolvedPath = operation.path;
    const url = new URL(this.#requestBaseUrl);
    const headers = new Headers(this.#headers);
    const cookieParameters: string[] = [];
    for (const parameter of operation.parameters) {
      const value = fields[parameter.name];
      if (parameter.in === "path") {
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an OpenAPI parameter value of 0, false or "" is a legal value to send; only null/undefined means the caller did not provide it
        if (value == null) throw new Error(`${operationId} needs "${parameter.name}"`);
        resolvedPath = resolvedPath.replaceAll(
          `{${parameter.name}}`,
          encodeURIComponent(String(value)),
        );
      } else if (parameter.in === "query") {
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an OpenAPI parameter value of 0, false or "" is a legal value to send; only null/undefined means the caller did not provide it
        if (value == null && parameter.required)
          throw new Error(`${operationId} needs query parameter "${parameter.name}"`);
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an OpenAPI parameter value of 0, false or "" is a legal value to send; only null/undefined means the caller did not provide it
        if (value != null) url.searchParams.set(parameter.name, String(value));
      } else if (parameter.in === "header") {
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an OpenAPI parameter value of 0, false or "" is a legal value to send; only null/undefined means the caller did not provide it
        if (value != null) headers.set(parameter.name, String(value));
      } else if (parameter.in === "cookie") {
        // oxlint-disable-next-line iterate/simple-truthiness-check -- an OpenAPI parameter value of 0, false or "" is a legal value to send; only null/undefined means the caller did not provide it
        if (value != null)
          cookieParameters.push(`${parameter.name}=${encodeURIComponent(String(value))}`);
      } else continue;
      delete fields[parameter.name];
    }
    // ONE Cookie header, `; `-joined (RFC 6265) after any cookie the connection's own headers carry
    // — `Headers.append` would join the pairs with `, `, which no server reads as two cookies.
    if (cookieParameters.length > 0)
      headers.set(
        "cookie",
        [headers.get("cookie"), ...cookieParameters].filter(Boolean).join("; "),
      );
    url.pathname = url.pathname.replace(/\/$/, "") + resolvedPath;
    const leftover = Object.keys(fields);
    let body: string | undefined;
    if (operation.hasRequestBody) {
      if (leftover.length > 0) {
        body = JSON.stringify(leftover.length === 1 && "body" in fields ? fields.body : fields);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    } else if (leftover.length > 0) {
      throw new Error(
        `${operationId} has no request body and got unknown input key${leftover.length > 1 ? "s" : ""} ${leftover.map((k) => JSON.stringify(k)).join(", ")}`,
      );
    }
    const response = await this.#itx.fetch(
      new Request(url, { method: operation.method.toUpperCase(), headers, body }),
    );
    await refuseUnlessOk(
      response,
      `${operation.method.toUpperCase()} ${url.pathname} (${operationId})`,
    );
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json") ? await response.json() : await response.text();
  }
}

async function fetchDocument(
  itx: LibraryItx,
  specUrl: string,
  options: OpenApiConnectOptions,
): Promise<OpenApiDocument> {
  // auth headers reach the spec only when it lives on the API's host (apps/os `specFetchHeaders`)
  const sameHost = !options.baseUrl || new URL(options.baseUrl).host === new URL(specUrl).host;
  const headers = sameHost ? options.headers || {} : {};
  const response = await refuseUnlessOk(
    await itx.fetch(new Request(specUrl, { headers })),
    `connectToOpenApi: fetching ${specUrl}`,
  );
  return (await response.json()) as OpenApiDocument;
}

/** `baseUrl`, else the document's first server (resolved against the spec URL), else the spec URL
 *  minus its last path segment — QUERY KEPT, so a fetch-lane URL stays addressed. */
function requestBase(
  spec: OpenApiDocument,
  specUrl: string | undefined,
  options: OpenApiConnectOptions,
): URL {
  if (options.baseUrl) return new URL(options.baseUrl);
  const serverUrl = spec.servers?.[0]?.url;
  const relative = serverUrl && !/^[a-z][a-z0-9+.-]*:/i.test(serverUrl);
  if (serverUrl && !(relative && !specUrl)) {
    const base = new URL(serverUrl, specUrl);
    // a RELATIVE server (`/api`, the common spelling) resolved against a fetch-lane spec URL keeps
    // the lane's `?context=&itx=` — dropping it would send every operation to the worker's banner
    if (relative && specUrl) base.search = new URL(specUrl).search;
    return base;
  }
  if (!specUrl)
    throw new Error(
      `connectToOpenApi: a document ${serverUrl ? `whose server is the relative ${JSON.stringify(serverUrl)}` : "without servers"} needs { baseUrl }`,
    );
  const base = new URL(specUrl);
  base.pathname = base.pathname.replace(/\/[^/]*$/, "");
  return base;
}

/** A concrete OpenAPI parameter — PARSED, never cast: a `$ref` parameter (or any malformed one) has no
 *  string `name`/`in`, so it fails this and is dropped instead of surfacing as `{ name: undefined }`
 *  that violates OpenApiOperation. An internal `$ref` (a shared `#/components/parameters/…`) is
 *  resolved first; an external ref (a URL or file) stays dropped — this lane fetches only the spec. */
const OpenAPIParameter = z.object({
  name: z.string(),
  in: z.string(),
  required: z.boolean().optional(),
});

/** Resolve an internal JSON pointer (`#/a/b`, RFC 6901 un-escaping) against the root document;
 *  `undefined` for an external ref or a missing target. */
function resolveInternalRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const segment of ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- node is untrusted JSON (unknown); after the null check it narrows to {} but may still be a string/number, so typeof-object is real validation before indexing
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Follow a `$ref` chain (internal only, cycle-guarded) to the concrete node it names. */
function derefInternal(root: unknown, node: unknown, seen = new Set<string>()): unknown {
  while (
    node != null &&
    // oxlint-disable-next-line iterate/simple-truthiness-check -- node is untrusted JSON (unknown); after the null check it narrows to {} but may still be a string/number, so typeof-object is real validation before reading .$ref
    typeof node === "object" &&
    typeof (node as { $ref?: unknown }).$ref === "string"
  ) {
    const ref = (node as { $ref: string }).$ref;
    if (seen.has(ref)) return undefined; // a ref cycle resolves to nothing, never a hang
    seen.add(ref);
    node = resolveInternalRef(root, ref);
  }
  return node;
}

const concreteParameters = (raw: unknown, spec: unknown): OpenApiOperation["parameters"] =>
  Array.isArray(raw)
    ? raw.flatMap((p) => {
        const parsed = OpenAPIParameter.safeParse(derefInternal(spec, p));
        return parsed.success ? [parsed.data] : [];
      })
    : [];

function listOperations(spec: OpenApiDocument): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths || {})) {
    const pathItem = derefInternal(spec, rawPathItem) as Record<string, unknown> | null;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- pathItem is untrusted JSON cast from derefInternal; the object guard is real validation before Object.entries (typeof null === "object", so the null check is also needed)
    if (!pathItem || typeof pathItem !== "object") continue;
    const pathParameters = concreteParameters(pathItem.parameters, spec);
    for (const [method, raw] of Object.entries(pathItem)) {
      // oxlint-disable-next-line iterate/simple-truthiness-check -- raw is untrusted JSON (unknown) from an OpenAPI path item; the object guard is real validation before casting to Record
      if (!HTTP_METHODS.has(method) || raw == null || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (typeof op.operationId !== "string") continue;
      const own = concreteParameters(op.parameters, spec);
      operations.push({
        operationId: op.operationId,
        method,
        path,
        // An operation's parameter OVERRIDES the path item's of the same (name, in) — the spec's rule.
        parameters: [
          ...pathParameters.filter(
            (inherited) => !own.some((o) => o.name === inherited.name && o.in === inherited.in),
          ),
          ...own,
        ],
        hasRequestBody: !!op.requestBody,
        ...(typeof op.summary === "string" && { summary: op.summary }),
      });
    }
  }
  return operations;
}
