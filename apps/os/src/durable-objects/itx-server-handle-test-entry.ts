import { WorkerEntrypoint } from "cloudflare:workers";
import { createD1Client } from "sqlfu";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import { getServerItx } from "~/itx/server.ts";
import { parseConfig } from "~/config.ts";
import { adminPrincipal, createUserPrincipal, type Principal } from "~/auth/principal.ts";
import type { RequestContext } from "~/request-context.ts";

export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";

// Must match the assertions in itx-server-handle.test.ts.
export const PROJECT_ID = "proj__test__itxserver";
export const PROJECT_SLUG = "itx-server-demo";

export type HarnessPrincipal = "admin" | "member" | "stranger" | "anonymous";

/**
 * Drives getServerItx exactly the way an SSR loader does, except the
 * RequestContext is hand-built (no TanStack request storage in a harness
 * worker): principal + db + config + ctx.exports in, in-process Itx handle
 * out, real StreamsCapability → Stream Durable Object underneath.
 */
export class ServerItxHarness extends WorkerEntrypoint<Env> {
  async appendMarker(input: { marker: string; path: string }): Promise<void> {
    const itx = await this.#serverItx({ principal: "member", slugOrId: PROJECT_SLUG });
    await itx.streams.get(input.path).append({
      type: "test.iterate.com/itx-server-handle/marker",
      payload: { marker: input.marker },
    });
  }

  /**
   * Resolved stream paths from itx.streams.list() under the given principal.
   * Failures come back as a value, not a rejection — a rejecting Workers RPC
   * promise is double-reported as an unhandled rejection inside the
   * vitest-pool-workers runner even when the test awaits it.
   */
  async listStreamPaths(input: {
    principal: HarnessPrincipal;
    slugOrId: string;
  }): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
    try {
      const itx = await this.#serverItx(input);
      const streams = await itx.streams.list();
      return { ok: true, paths: streams.map((stream) => stream.streamPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async #serverItx(input: { principal: HarnessPrincipal; slugOrId: string }) {
    await this.#seedProject();
    return await getServerItx(input.slugOrId, this.#requestContext(input.principal));
  }

  #requestContext(principal: HarnessPrincipal): RequestContext {
    return {
      config: parseConfig(this.env),
      db: createD1Client(this.env.DB),
      log: createRequestLogger({ method: "TEST", path: "/itx-server-handle" }),
      principal: harnessPrincipal(principal),
      workerExports: this.ctx.exports as unknown as Cloudflare.Exports,
    };
  }

  async #seedProject(): Promise<void> {
    // The projects table slice resolveAccessibleContextId reads (the full
    // schema lives in src/db/definitions.sql; ingress etc. is not exercised).
    await this.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS projects (
        id text primary key not null,
        slug text not null unique,
        custom_hostname text unique,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      )`,
    ).run();
    await this.env.DB.prepare(`INSERT OR IGNORE INTO projects (id, slug) VALUES (?, ?)`)
      .bind(PROJECT_ID, PROJECT_SLUG)
      .run();
  }
}

function harnessPrincipal(kind: HarnessPrincipal): Principal | null {
  switch (kind) {
    case "admin":
      return adminPrincipal;
    case "member":
      return createUserPrincipal({
        userId: "user_member",
        organizations: [],
        projects: [{ id: PROJECT_ID, slug: PROJECT_SLUG, organizationId: "org_test" }],
      });
    case "stranger":
      return createUserPrincipal({
        userId: "user_stranger",
        organizations: [],
        projects: [],
      });
    case "anonymous":
      return null;
  }
}

export default {
  async fetch() {
    return new Response("itx server handle test worker");
  },
} satisfies ExportedHandler<Env>;
