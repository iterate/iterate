// The restorer (spec §5.2): the single function that turns serializable
// ItxProps into a live handle, plus the two WorkerEntrypoints the platform
// wires into isolates it loads:
//
//   env.ITERATE      = ctx.exports.ItxEntrypoint({ props: { context } })
//   globalOutbound   = ctx.exports.ProjectEgress({ props: { projectId } })
//
// Props are sturdy refs (Law 2). The conversion from data back to authority
// happens HERE and at connect-time auth (fetch.ts) — nowhere else.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Itx, type ItxRuntime } from "./handle.ts";
import {
  GLOBAL_CONTEXT_ID,
  isChildContextId,
  resolveDialableTargets,
  type ItxProps,
  type PathCall,
} from "./protocol.ts";
import { replayPathCall } from "./path-proxy.ts";
import type { ContextDO } from "./context-do.ts";
import { parseConfig } from "~/config.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";

/**
 * restore(): names → live object graph. A project-context handle's access is
 * always exactly its own project, regardless of what props claim — same
 * non-escalation rule the old config-worker scope rewrite enforced (D7).
 * Async because child contexts (ctx_…) resolve their owning project from
 * their ContextDO descriptor — the one lookup a sturdy ref costs.
 */
export async function resolveItx(input: {
  env: Env;
  exports: ItxRuntime["exports"];
  props: ItxProps;
}): Promise<Itx> {
  const config = parseConfig(input.env);
  const contextId = input.props.context;

  let projectId: string | null;
  if (contextId === GLOBAL_CONTEXT_ID) {
    projectId = null;
  } else if (isChildContextId(contextId)) {
    const contextDo = input.env.ITX_CONTEXT.getByName(
      contextId,
    ) as unknown as DurableObjectStub<ContextDO>;
    projectId = (await contextDo.descriptor()).projectId;
  } else {
    projectId = contextId;
  }

  return new Itx({
    access: contextId === GLOBAL_CONTEXT_ID ? (input.props.access ?? []) : [projectId!],
    cap: input.props.cap,
    config,
    contextId,
    env: input.env,
    exports: input.exports,
    projectId,
  });
}

/**
 * The binding every platform-loaded isolate receives as env.ITERATE.
 * Inside the isolate: `const itx = await env.ITERATE.context` — the getter
 * returns a promise so the restorer can resolve child-context descriptors.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxProps> {
  get context(): Promise<Itx> {
    return resolveItx({
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      props: this.ctx.props,
    });
  }
}

export type ProjectEgressProps = {
  /** The owning project. Registry-injected at dial time (never definer
   * props), so a `fetch` cap can only ever scope to its own project. */
  projectId: string;
  /** Attribution only: which context/cap is fetching (audit + future policy). */
  context?: string;
  cap?: string;
};

/**
 * One pipe, two doors (Law 5) — and the pipe itself is the project's `fetch`
 * CAPABILITY (a platform:project default), so any handle holder can shadow
 * it with a live provider and intercept ALL project egress.
 *
 * - `fetch` is the implicit door: bound as `globalOutbound` for every isolate
 *   the platform loads, so bare fetch() — including fetches made by npm
 *   dependencies the loaded code bundles — routes REGISTRY-FIRST through the
 *   `fetch` cap, same as itx.fetch() (the explicit door).
 * - `call` is the TERMINAL pipe the DEFAULT `fetch` cap dials: it lands on
 *   the Project DO's egressFetch, where secret placeholder substitution and
 *   (future) approval policy live. The default dials `call`, never `fetch` —
 *   that is what breaks the loop.
 *
 * A live shadow provider receives requests with getSecret(...) placeholders
 * UNSUBSTITUTED — substitution only happens in the default pipe inside the
 * Project DO. That is the security property: an interceptor never sees
 * secret material.
 */
export class ProjectEgress extends WorkerEntrypoint<Env, ProjectEgressProps> {
  async fetch(request: Request): Promise<Response> {
    return (await this.#project().itxInvoke({
      args: [request],
      name: "fetch",
      path: [],
    })) as Response;
  }

  async call({ args }: PathCall): Promise<Response> {
    const [input, init] = args;
    if (!(input instanceof Request) && typeof input !== "string") {
      throw new Error("The fetch capability expects call({ path: [], args: [request] }).");
    }
    const request = input instanceof Request ? input : new Request(input, init as RequestInit);
    return await this.#project().egressFetch(request);
  }

  #project() {
    return this.env.PROJECT.getByName(getProjectDurableObjectName(this.ctx.props.projectId));
  }
}

export type BindingCapabilityProps = {
  /** Which env binding this instance wraps. Definer-supplied. */
  binding: string;
  /** Attribution, injected by the registry at dial time. */
  cap?: string;
  context?: string;
};

/**
 * The thin policy wrapper for platform bindings (itx-next.md §2): a
 * loopback-dialable, path-call capability that applies the dotted path to
 * `env[props.binding]`, receiver-preserving. Today the only policy is the
 * DIALABLE_BINDINGS allowlist — props.binding is definer-controlled, so the
 * check HERE is the authoritative gate for which binding gets wrapped.
 * Gateway selection / attribution headers / quotas slot in here later.
 *
 * Registered via:
 *   target: { type: "rpc", worker: { type: "loopback" },
 *             entrypoint: "BindingCapability", props: { binding: "AI" } }
 */
export class BindingCapability extends WorkerEntrypoint<Env, BindingCapabilityProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    const dialable = resolveDialableTargets(parseConfig(this.env).itx);
    if (!dialable.bindings.has(props.binding)) {
      throw new Error(`Binding "${props.binding}" is not dialable as a capability.`);
    }
    const binding = (this.env as unknown as Record<string, unknown>)[props.binding];
    if (binding == null) {
      throw new Error(`Binding "${props.binding}" is not available in this environment.`);
    }
    return await replayPathCall(binding, input);
  }
}
