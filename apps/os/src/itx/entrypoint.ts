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
import { ItxHandle, type ItxRuntime } from "./handle.ts";
import {
  contextAddressOf,
  dialContext,
  isChildContextAddress,
  replayPathCall,
  resolveDialableTargets,
  type PathCall,
} from "./itx.ts";
import { GLOBAL_CONTEXT_ID, type ItxProps } from "./refs.ts";
import { parseConfig } from "~/config.ts";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";

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
}): Promise<ItxHandle> {
  const config = parseConfig(input.env);
  const contextId = input.props.context;

  let projectId: string | null;
  if (contextId === GLOBAL_CONTEXT_ID) {
    // Global handle minting stays connect-time — the global context has no
    // node to dial yet (address unification step (c)).
    projectId = null;
  } else {
    const address = contextAddressOf(contextId);
    // A project context's identity IS its project; a child node resolves its
    // owning project from its descriptor — the one lookup a sturdy ref costs.
    projectId = isChildContextAddress(address)
      ? (await dialContext(input.env, address).descriptor!()).projectId
      : contextId;
  }

  return new ItxHandle({
    access: contextId === GLOBAL_CONTEXT_ID ? (input.props.access ?? []) : [projectId!],
    capabilityPath: input.props.capabilityPath,
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
  get context(): Promise<ItxHandle> {
    return resolveItx({
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      props: this.ctx.props,
    });
  }
}

export type ProjectEgressProps = {
  /** The owning project. Registry-injected at dial time (never provider
   * props), so a `fetch` cap can only ever scope to its own project. */
  projectId: string;
  /** Attribution only: which context/cap is fetching (audit + future policy). */
  context?: string;
  capabilityPath?: string;
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
 * - The DEFAULT `fetch` cap target is EgressPipe (below): the TERMINAL,
 *   stateless pipe where secret placeholder substitution and the real fetch
 *   happen. The default is a DIFFERENT entrypoint from this dispatcher —
 *   that is what breaks the loop.
 *
 * A live shadow provider receives requests with getSecret(...) placeholders
 * UNSUBSTITUTED — substitution only happens in the default pipe. That is the
 * security property: an interceptor never sees secret material.
 */
export class ProjectEgress extends WorkerEntrypoint<Env, ProjectEgressProps> {
  async fetch(request: Request): Promise<Response> {
    // Dispatch at the ORIGINATING context node, not the project: a child
    // context's `fetch` shadow must catch its isolates' bare fetch() too —
    // the chain (child → project → defaults) is what resolves the cap.
    const context = this.ctx.props.context ?? this.ctx.props.projectId;
    const node = dialContext(this.env, contextAddressOf(context));
    return (await node.itx().invoke({ args: [request], path: ["fetch"] })) as Response;
  }
}

export type EgressPipeProps = {
  /** Injected by the registry at dial time — never provider-supplied. */
  projectId?: string;
  /** Attribution only: which context/cap is fetching (audit + future policy). */
  context?: string;
  capabilityPath?: string;
};

/**
 * The TERMINAL egress pipe: the default target of the `fetch` capability
 * (PLATFORM_PROJECT_CAPABILITIES, durable-itx.ts). Stateless: secrets are D1 rows
 * (domains/secrets), scoped by the registry-injected projectId, so
 * substitution and the real fetch happen here in a plain isolate — the
 * Project DO supervises dispatch (its registry is where live shadows live)
 * but secret material never enters it. Future egress policy (allowlists,
 * human-in-the-loop approval) slots in here.
 */
export class EgressPipe extends WorkerEntrypoint<Env, EgressPipeProps> {
  async call({ args }: PathCall): Promise<Response> {
    const [input, init] = args;
    if (!(input instanceof Request) && typeof input !== "string") {
      throw new Error("The fetch capability expects call({ path: [], args: [request] }).");
    }
    const request = input instanceof Request ? input : new Request(input, init as RequestInit);

    const projectId = this.ctx.props.projectId;
    if (!projectId) {
      throw new Error("EgressPipe needs registry-injected projectId props.");
    }
    if (!isHttpRequestUrl(request.url)) {
      return await fetch(request);
    }

    const secrets = getSecretsCapability({
      exports: this.ctx.exports as unknown as Parameters<typeof getSecretsCapability>[0]["exports"],
      props: { projectId },
    });
    const [substitutionError, substitutedHeaders] = await substituteProjectEgressSecretHeaders({
      headers: request.headers,
      secrets,
    });
    if (substitutionError) return substitutionError;

    const outboundHeaders = new Headers(request.headers);
    for (const [header, value] of Object.entries(substitutedHeaders)) {
      outboundHeaders.set(header, value);
    }
    return await fetch(new Request(request, { headers: outboundHeaders }));
  }
}

function isHttpRequestUrl(urlString: string) {
  const url = new URL(urlString);
  return url.protocol === "http:" || url.protocol === "https:";
}

export type BindingCapabilityProps = {
  /** Which env binding this instance wraps. Provider-supplied. */
  binding: string;
  /** Attribution, injected by the registry at dial time. */
  capabilityPath?: string;
  context?: string;
};

/**
 * The thin policy wrapper for platform bindings (itx-next.md §2): a
 * loopback-dialable, path-call capability that applies the dotted path to
 * `env[props.binding]`, receiver-preserving. Today the only policy is the
 * DIALABLE_BINDINGS allowlist — props.binding is provider-controlled, so the
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
