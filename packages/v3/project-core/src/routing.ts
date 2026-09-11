import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { address, expectedFailure, Fault, httpError, WorkerMount } from "./model.ts";
import { EgressPolicy } from "./egress.ts";
import { loadSource } from "./runtime.ts";
import { resolveProjectHost } from "./ingress.ts";
import type { Env } from "./worker.ts";

export const Terminal = z.strictObject({
  policyOffset: z.number().int().positive(),
  approval: EgressPolicy,
});
export const FetchTarget = z.discriminatedUnion("kind", [
  WorkerMount,
  z.strictObject({ kind: z.literal("network"), approval: EgressPolicy }),
]);
type Location = { project: string; path: string };
type PolicyProps = Location & { policyOffset: number };
type DestinationProps = PolicyProps & { target: z.infer<typeof FetchTarget> };
export type CoreExports = {
  Host(options: { props: Location }): Fetcher;
  FetchNext(options: { props: PolicyProps }): Fetcher;
  FetchDestination(options: { props: DestinationProps }): Fetcher;
};

/** Strip protocol authority at every ordinary entry, while preserving an approval reference. */
export function cleanFetchRequest(request: Request) {
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (
      key.startsWith("x-core-") ||
      key.startsWith("x-itx-") ||
      key.startsWith("x-iterate-") ||
      (key.startsWith("x-project-core-") && key !== "x-project-core-approval")
    )
      headers.delete(key);
  }
  return new Request(request, { headers, redirect: "manual" });
}

/** All ordinary HTTP enters here. The Context supplies data, never proxies the policy response. */
export async function routeFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  location: Location,
): Promise<Response> {
  try {
    const name = address(location.project, location.path).name;
    const context = env.CONTEXT.getByName(name);
    const snapshot = await context.readFetchPolicy();
    if (snapshot.error) return httpError(snapshot.error);
    const { target, policyOffset } = snapshot.result;
    // Native loopback exports are this module's stateless entrypoints; no generated types exist.
    const exports = ctx.exports as unknown as CoreExports;
    const worker = await loadSource(target.source, {
      env,
      owner: `${name}:fetch:${policyOffset}`,
      // Fetch owns a fresh child: named children have native response-lifetime failures
      // on preview (ws-probe/README.md). RPC and build caches remain independent.
      cache: false,
      host: exports.Host({ props: location }),
      next: exports.FetchNext({ props: { ...location, policyOffset } }),
      filesForRepo: async (repo, revision) => {
        const result = await context.readRepo(repo, revision);
        if (result.error)
          throw new Fault(result.error.code, result.error.message, result.error.status);
        return result.result.files;
      },
    });
    const clean = cleanFetchRequest(request);
    const destination = resolveProjectHost(new URL(clean.url), env);
    if (destination?.projectId === location.project && destination.app)
      clean.headers.set("x-iterate-app", destination.app);
    return await worker.getEntrypoint(target.exportName).fetch(clean);
  } catch (error) {
    return httpError(expectedFailure(error));
  }
}

/** Only the installed policy receives this authority; normal ITX does not expose it. */
export class FetchNext extends WorkerEntrypoint<Env, PolicyProps> {
  to(value: unknown) {
    const target = FetchTarget.parse(value);
    if (new TextEncoder().encode(JSON.stringify(target)).byteLength > 524288)
      throw new Fault("FETCH_TARGET_LIMIT", "Destination descriptor exceeds 512 KiB", 413);
    // These are this static module's loopback exports, with serializable construction props.
    const exports = this.ctx.exports as unknown as CoreExports;
    return exports.FetchDestination({ props: { ...this.ctx.props, target } });
  }
}

/** A static Fetcher can cross RPC; its dynamic child stays here, preserving native WebSockets. */
export class FetchDestination extends WorkerEntrypoint<Env, DestinationProps> {
  override async fetch(request: Request): Promise<Response> {
    const { project, path, policyOffset, target } = this.ctx.props;
    const location = address(project, path);
    const context = this.env.CONTEXT.getByName(location.name);
    if ((await context.fetchPolicyOffset()) !== policyOffset)
      return Response.json({ error: { code: "FETCH_POLICY_CHANGED" } }, { status: 409 });
    const clean = cleanFetchRequest(request);
    if (target.kind === "network") {
      // Only this private Fetcher creates the terminal marker; every public/ITX Host strips it.
      const headers = new Headers(clean.headers);
      headers.set("x-core-terminal", JSON.stringify({ policyOffset, approval: target.approval }));
      return context.fetch(new Request(clean, { headers }));
    }
    // Native export typing is shared with Context; no dynamic entrypoint is transferred.
    const exports = this.ctx.exports as unknown as CoreExports;
    try {
      const worker = await loadSource(target.source, {
        env: this.env,
        owner: `${location.name}:itx`,
        // Match the policy's request-scoped loading; preserve the native response stream.
        cache: false,
        host: exports.Host({ props: location }),
        filesForRepo: async (repo, revision) => {
          const result = await context.readRepo(repo, revision);
          if (result.error)
            throw new Fault(result.error.code, result.error.message, result.error.status);
          return result.result.files;
        },
      });
      const response = await worker.getEntrypoint(target.exportName).fetch(clean);
      // Own the forwarded body through EOF; raw nested child streams can cancel their carriers.
      // Keep upgrades/bodyless responses native. See evidence/fetch-lifetime.md for the red loop.
      return response.body
        ? new Response(response.body.pipeThrough(new TransformStream()), response)
        : response;
    } catch (error) {
      return httpError(expectedFailure(error));
    }
  }
}
