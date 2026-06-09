// The restorer (spec §5.2): the single function that turns serializable
// ItxProps into a live handle, plus the two WorkerEntrypoints the platform
// wires into isolates it loads:
//
//   env.ITERATE      = ctx.exports.ItxEntrypoint({ props: { context } })
//   globalOutbound   = ctx.exports.ProjectEgress({ props: { project } })
//
// Props are sturdy refs (Law 2). The conversion from data back to authority
// happens HERE and at connect-time auth (fetch.ts) — nowhere else.

import { WorkerEntrypoint } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { Itx, type ItxRuntime } from "./handle.ts";
import { GLOBAL_CONTEXT_ID, type ItxProps } from "./protocol.ts";
import { AppConfig } from "~/app.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";

/**
 * restore(): names → live object graph. A project-context handle's access is
 * always exactly its own project, regardless of what props claim — same
 * non-escalation rule the old config-worker scope rewrite enforced (D7).
 */
export function resolveItx(input: {
  env: Env;
  exports: ItxRuntime["exports"];
  props: ItxProps;
}): Itx {
  const config = parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: input.env as unknown as Record<string, unknown>,
  });
  const contextId = input.props.context;
  return new Itx({
    access: contextId === GLOBAL_CONTEXT_ID ? (input.props.access ?? []) : [contextId],
    cap: input.props.cap,
    config,
    contextId,
    env: input.env,
    exports: input.exports,
  });
}

/**
 * The binding every platform-loaded isolate receives as env.ITERATE.
 * Inside the isolate: `const itx = await env.ITERATE.context`.
 */
export class ItxEntrypoint extends WorkerEntrypoint<Env, ItxProps> {
  get context(): Itx {
    const workerCtx = Reflect.get(this, "ctx") as ExecutionContext<ItxProps>;
    return resolveItx({
      env: this.env,
      exports: workerCtx.exports as unknown as ItxRuntime["exports"],
      props: workerCtx.props,
    });
  }
}

export type ProjectEgressProps = {
  project: string;
  /** Attribution only: which context/cap is fetching (audit + future policy). */
  context?: string;
  cap?: string;
};

/**
 * One pipe, two doors (Law 5). This is the implicit door: bound as
 * `globalOutbound` for every isolate the platform loads, so bare fetch() —
 * including fetches made by npm dependencies the loaded code bundles — IS
 * project egress: secret placeholder substitution, the egress intercept
 * tunnel, and (future) human approval all happen inside the Project DO.
 * The explicit door is itx.fetch(), which lands on the same DO method.
 */
export class ProjectEgress extends WorkerEntrypoint<Env, ProjectEgressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = (Reflect.get(this, "ctx") as ExecutionContext<ProjectEgressProps>).props;
    return await this.env.PROJECT.getByName(getProjectDurableObjectName(props.project)).egressFetch(
      request,
    );
  }
}
