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
 *  alike: every other context's name and Durable Object, its rule snapshot as this isolate holds
 *  it (context/rule-snapshots.ts), one call there (`located`: built-ins.ts `callContext`, whose
 *  invoke rides `contextStub` — context-stub.ts's retry and failure policy on every hop), and
 *  `workers` speaking for it — loaded here, with its loader identity, its `env.ITX` minted from
 *  `ctx`'s exports, its producer run there as its loaded code. A hop carries `platformOrigin()`
 *  when its caller names none: an alarm's delivery has no caller to carry one. `namespace` is the
 *  contexts' binding, the privileged reach only a context or the entrypoint holds. `delivery` is
 *  the delivery authority of the call being made (caller.ts `Caller.delivery`), read as it is
 *  made: a context's Durable Object reads its ambient caller's; the stateless entrypoint passes
 *  none, so a call loaded code makes never carries one. */
export function contextReach(args: {
  env: Env;
  namespace: Env["ITERATE_CONTEXT"];
  projectId: string;
  platformOrigin: () => string | null;
  ctx: DurableObjectState | ExecutionContext;
  delivery?: () => string | undefined;
  /** The cause of the call being made (caller.ts `Caller.cause`), read as it is made. */
  cause?: () => Cause | undefined;
  /** False for a context's Durable Object, whose calls send on the call it was made: a run's
   *  request is answered up as it came, for its caller's side to read (context-stub.ts). */
  readsRunSettlements?: boolean;
}) {
  const { env, namespace, projectId, platformOrigin, readsRunSettlements } = args;
  const nameOf = (path: string) => DurableObjectNameCodec.stringify({ projectId, path });
  const context = (path: string) => namespace.getByName(nameOf(path));
  const callAt = (
    path: string,
    expression: ItxExpression,
    callArgs: unknown[],
    caller: Caller,
    delivery?: () => string | undefined,
  ): Promise<unknown> => {
    const callerThere = { ...caller, platformOrigin: caller.platformOrigin || platformOrigin() };
    return callContext(
      () => ({
        fetch: (request) => context(path).fetch(request),
        invoke: (target, targetArgs = [], targetCaller = callerThere) =>
          contextStub(namespace, DurableObjectNameCodec.address({ projectId, path }), "itx", {
            readsRunSettlements,
          }).invoke(normalizedItxExpression(target), targetArgs, targetCaller),
      }),
      expression,
      callArgs,
      callerThere,
      path,
      delivery,
    );
  };
  return {
    nameOf,
    contextOf: context,
    snapshotOf: (path: string) =>
      ruleSnapshots.get(
        nameOf(path),
        (ifVersion) =>
          context(path).rulesSnapshot(ifVersion) as unknown as Promise<RulesSnapshotAnswer>,
      ),
    located: (path: string, expression: ItxExpression, callArgs: unknown[], caller: Caller) =>
      callAt(path, expression, callArgs, caller, args.delivery),
    workersOf: (path: string, caller: Caller, hops: number) => {
      // the cause of the call being made, read as it is made (a row's target is resolved once and
      // called for each delivery), plus the contexts it crossed to get here (cause.ts)
      const cause = () => {
        let crossed = args.cause?.();
        for (let hop = 0; crossed && hop < hops; hop++) crossed = crossingOneMore(crossed, path);
        return crossed;
      };
      // the resolver of the context at `at`, the platform's (`app` unset) or its loaded code's
      const resolverAt = (at: string, app?: true) =>
        statelessResolverFor({
          env,
          namespace: args.namespace,
          address: DurableObjectNameCodec.address({ projectId, path: at }),
          caller: { principal: null, app, platformOrigin: platformOrigin(), cause: cause() },
          ctx: args.ctx,
        });
      return workersRoot({
        env,
        deployId: appConfigOf(env).deployId,
        projectId,
        path,
        iterateContextName: nameOf(path),
        platformOrigin,
        itxEntrypoint: () => itxEntrypointFor(args.ctx, nameOf(path), platformOrigin()),
        // A producer is loaded code's word at `path`, never the delivery's, under the call's cause
        // — resolved HERE, so what it reads through a portable root (the config repo's `repos`) is
        // walked in this isolate and no cold load is relayed through `path`'s context.
        invoke: (call) => resolverAt(path, true).invoke(call),
        // A name is read as the platform from `path` (it only reads rules); the producer of the
        // worker it names runs as the loaded code of the context whose rule that is, as a
        // context's own `#namedWorker` runs it.
        namedWorker: async (source) => {
          const { at, spec, vouched } = await resolverAt(path).namedWorker(source);
          return { spec, vouched, invoke: (call) => resolverAt(at, true).invoke(call) };
        },
        caller: () => caller,
        delivery: () => args.delivery?.(),
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
    cause: () => caller.cause,
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
      library,
    });
    return new ItxExpressionResolver({
      ...reach,
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
      projectId,
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
