// context/stateless-context.ts — A CONTEXT'S REACH WITHOUT ITS DURABLE OBJECT, for the stateless
// `ItxEntrypoint` (iterate-context.ts) every loaded worker and first-party facet reaches its context
// through: the same resolver and walls a context's Durable Object dispatches with
// (itx-expression-rewriting.ts `ItxExpressionResolver`), over snapshots of every table, its own
// context's included, and only the built-ins that answer the same anywhere
// (built-ins.ts `buildPortableBuiltIns`). Where each call runs is `ItxExpressionResolver.invoke`'s
// contract, and how fresh a snapshot is context/rule-snapshots.ts's.

import { InvokeHandle, normalizedItxExpression, type ItxExpression } from "iterate/expression";
import { crossingOneMore, type Cause } from "../cause.ts";
import type { Caller } from "../caller.ts";
import type { Env } from "../iterate-context-durable-object.ts";
import { appConfigOf } from "../app-config.ts";
import { ControlPlane } from "../control-plane/edge.ts";
import { contextStub } from "../context-stub.ts";
import { itxAiFor } from "../itx-ai.ts";
import { buildLibrary, type LibraryItx } from "../library.ts";
import {
  buildIdentityRoots,
  buildPortableBuiltIns,
  callContext,
  projectConfigDeps,
  workersRoot,
} from "./built-ins.ts";
import { egress } from "./egress.ts";
import { ItxExpressionResolver } from "./itx-expression-rewriting.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID, type DurableObjectAddress } from "./paths.ts";
import { ruleSnapshots, type RulesSnapshotAnswer } from "./rule-snapshots.ts";

/** A CONTEXT'S REACH INTO ITS PROJECT, a context's Durable Object's and the stateless resolver's
 *  alike (itx-expression-rewriting.ts `ResolverReach`): every other context's Durable Object, its
 *  rule snapshot as this isolate holds it (context/rule-snapshots.ts), one call there (`located`:
 *  built-ins.ts `callContext`, whose invoke rides `contextStub` — context-stub.ts's retry and
 *  failure policy on every hop), `workers` speaking for it — loaded here, with its loader identity,
 *  its `env.ITX` minted from `ctx`'s exports — and its loaded code resolved here (`loadedCodeAt`:
 *  always statelessly, so a cold load relays nothing through that context). A hop carries
 *  `platformOrigin()` when its caller names none: an alarm's delivery has no caller to carry one.
 *  `ambient` is the call being made, read as it is made — its delivery authority (caller.ts
 *  `Caller.delivery`) and its cause: a context's Durable Object reads its ambient caller's; the
 *  stateless resolver its caller's cause alone, so a call loaded code makes never carries a
 *  delivery. `namespace` is the contexts' binding, the privileged reach only a context or the
 *  entrypoint holds. */
export function contextReach(args: {
  env: Env;
  namespace: Env["ITERATE_CONTEXT"];
  projectId: string;
  platformOrigin: () => string | null;
  ctx: DurableObjectState | ExecutionContext;
  ambient?: () => Pick<Caller, "delivery" | "cause">;
  /** False for a context's Durable Object, whose calls send on the call it was made: a run's
   *  request is answered up as it came, for its caller's side to read (context-stub.ts). */
  readsRunSettlements?: boolean;
}) {
  const { env, namespace, projectId, platformOrigin, readsRunSettlements } = args;
  const ambient: () => Pick<Caller, "delivery" | "cause"> = args.ambient || (() => ({}));
  const nameOf = (path: string) => DurableObjectNameCodec.stringify({ projectId, path });
  const contextOf = (path: string) => namespace.getByName(nameOf(path));
  const addressOf = (path: string) => DurableObjectNameCodec.address({ projectId, path });
  /** The resolver of the context at `path` for a caller of no one, the platform's or (`app`) its
   *  loaded code's, under `cause`. */
  const resolverAt = (path: string, cause: Cause | undefined, app?: true) =>
    statelessResolverFor({
      env,
      namespace,
      address: addressOf(path),
      caller: { principal: null, app, platformOrigin: platformOrigin(), cause },
      ctx: args.ctx,
    });
  const loadedCodeAt = (path: string, cause: Cause | undefined) => (call: ItxExpression) =>
    resolverAt(path, cause, true).invoke(call);
  return {
    projectId,
    contextOf,
    loadedCodeAt,
    recordLoopLimit: (path: string, cause: Cause, message: string) =>
      args.ctx.waitUntil(contextOf(path).recordLoopLimit(cause, message)),
    snapshotOf: (path: string) =>
      ruleSnapshots.get(
        nameOf(path),
        (ifVersion) =>
          contextOf(path).rulesSnapshot(ifVersion) as unknown as Promise<RulesSnapshotAnswer>,
      ),
    located: (path: string, expression: ItxExpression, callArgs: unknown[], caller: Caller) => {
      const callerThere = { ...caller, platformOrigin: caller.platformOrigin || platformOrigin() };
      return callContext(
        () => ({
          fetch: (request) => contextOf(path).fetch(request),
          invoke: (target, targetArgs = [], targetCaller = callerThere) =>
            contextStub(namespace, addressOf(path), "itx", { readsRunSettlements }).invoke(
              normalizedItxExpression(target),
              targetArgs,
              targetCaller,
            ),
        }),
        expression,
        callArgs,
        callerThere,
        path,
        () => ambient().delivery,
      );
    },
    workersOf: (path: string, caller: Caller, hops: number) => {
      // the cause of the call being made, read as it is made (a row's target is resolved once and
      // called for each delivery), plus the contexts it crossed to get here (cause.ts)
      const cause = () => {
        const now = ambient().cause;
        return now && hops ? crossingOneMore(now, path, hops) : now;
      };
      return workersRoot({
        env,
        deployId: appConfigOf(env).deployId,
        projectId,
        path,
        iterateContextName: nameOf(path),
        platformOrigin,
        itxEntrypoint: () => itxEntrypointFor(args.ctx, nameOf(path), platformOrigin()),
        // A producer is loaded code's word at `path`, never the delivery's, under the call's cause.
        invoke: (call) => loadedCodeAt(path, cause())(call),
        // A name is read as the platform from `path` (it only reads rules); the producer of the
        // worker it names runs as the loaded code of the context whose rule that is, as a
        // context's own `#namedWorker` runs it.
        namedWorker: async (source) => {
          const { at, spec, vouched } = await resolverAt(path, cause()).namedWorker(source);
          return { spec, vouched, invoke: (call) => loadedCodeAt(at, cause())(call) };
        },
        caller: () => caller,
        delivery: () => ambient().delivery,
        cause,
      });
    },
  };
}

/** The loopback stubs `ctx` minted, by context and origin (`itxEntrypointFor`). */
const itxEntrypointsByCtx = new WeakMap<object, Map<string, Fetcher>>();

/** The loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })` on a Durable Object's
 *  state or a worker's execution context (workers-types puts the worker's export table on both),
 *  minted once per `ctx`: a loaded worker's identity keeps a dead id's recovery per stub
 *  (worker-loader.ts `loaderIdGenerations`), so every load `ctx` makes shares one recovery.
 *  `Cloudflare.Exports` is `{}` without a generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(
  ctx: DurableObjectState | ExecutionContext,
  iterateContextName: string,
  platformOrigin: string | null,
): Fetcher {
  const minted = itxEntrypointsByCtx.get(ctx) ?? new Map<string, Fetcher>();
  itxEntrypointsByCtx.set(ctx, minted);
  const key = JSON.stringify([iterateContextName, platformOrigin]);
  const known = minted.get(key);
  if (known) return known;
  const { exports } = ctx as unknown as {
    exports: {
      ItxEntrypoint(opts: {
        props: { iterateContextName: string; platformOrigin: string | null };
      }): Fetcher;
    };
  };
  const stub = exports.ItxEntrypoint({ props: { iterateContextName, platformOrigin } });
  minted.set(key, stub);
  return stub;
}

/** The resolver of the context at `address` for `caller`, with no Durable Object of its own, in
 *  the worker whose execution context is `ctx` and which holds the contexts' binding (`namespace`,
 *  `contextReach`). Built per round trip: it holds nothing but closures. */
export function statelessResolverFor(args: {
  env: Env;
  namespace: Env["ITERATE_CONTEXT"];
  address: DurableObjectAddress;
  caller: Caller;
  ctx: DurableObjectState | ExecutionContext;
}): ItxExpressionResolver {
  const { env, address, caller } = args;
  const { projectId, path } = address;
  const appConfig = appConfigOf(env);
  const platformOrigin = caller.platformOrigin || appConfig.urls.os || null;
  const reach = contextReach({
    env,
    namespace: args.namespace,
    projectId,
    platformOrigin: () => platformOrigin,
    ambient: () => ({ cause: caller.cause }),
    ctx: args.ctx,
  });
  const context = reach.contextOf;
  const withOrigin = (call: Caller): Caller => ({ ...call, platformOrigin });
  // the catalog's row of the project, read at most once per round trip
  let catalogRow: ReturnType<ControlPlane["getProject"]> | undefined;
  const project = () =>
    projectId === GLOBAL_PROJECT_ID
      ? Promise.resolve(null)
      : (catalogRow ||= new ControlPlane(env).getProject(projectId));
  const projectDeps = projectConfigDeps(appConfig, async () => (await project())?.slug);
  // The built-ins speak for the caller the resolver runs under: the library's hops (`cd` to the
  // catalog, a repo) go as the platform's, never as the loaded code they serve. Every portable root
  // but the connectors, whose live connections the context's library memoizes and its residency
  // releases — made here, one would be opened per round trip and held by no one: the resolver sends
  // a call to one to the context.
  const resolverUnder = (callerNow: Caller) => {
    const {
      connectToMcp: _mcp,
      connectToOpenApi: _openApi,
      connectToCapnweb: _capnweb,
      ...builtIns
    } = buildPortableBuiltIns({
      ...projectDeps,
      projectId,
      path,
      ai: itxAiFor(args.ctx, projectId),
      env,
      context,
      egress: (request) =>
        egress(request, {
          projectId,
          path,
          cause: callerNow.cause,
          secretFetch: (secretPath, outbound) => context(secretPath).fetch(outbound),
        }),
      caller: () => withOrigin(callerNow),
      invokeAs: (callerThere, call) => resolverUnder(callerThere).invoke(call),
      library,
    });
    return new ItxExpressionResolver({
      reach,
      builtIns: {
        ...builtIns,
        ...buildIdentityRoots({
          ...projectDeps,
          projectId,
          path,
          platformOrigin: () => platformOrigin,
          primaryHostname: async () => (await project())?.primaryHostname ?? null,
        }),
      },
      path,
      caller: () => withOrigin(callerNow),
    });
  };
  // The library's itx, the platform's own hops (the caller without its `app`, as a context's
  // library runs them): its dotted surface reduces onto one dispatch (the prototype fallback,
  // iterate-context.ts) — which is why it is cast: InvokeHandle's declared type has none of those
  // members.
  const { app: _loadedCode, ...libraryCaller } = caller;
  const libraryItx = new InvokeHandle((steps) =>
    resolverUnder(libraryCaller).invoke(["itx", ...steps]),
  ) as unknown as LibraryItx;
  const library = buildLibrary(libraryItx, { caller: () => withOrigin(caller), path }).roots;
  return resolverUnder(caller);
}
