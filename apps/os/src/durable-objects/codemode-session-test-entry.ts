import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";

export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { FetchCapability } from "~/domains/codemode/fetch-capability.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  args: Record<string, unknown>[];
};

export class ProviderA extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.exclaimViaB") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const [request] = input.args;
      const result = (await ctx.providerB.text.exclaim({
        value: request?.value,
      })) as { value: string };

      return {
        provider: "provider-a",
        route: "codemode-session-capability",
        toolFunction: "compose.exclaimViaB",
        value: result.value,
      };
    }

    if (path === "math.add") {
      const [request] = input.args;
      return {
        provider: "provider-a",
        toolFunction: "math.add",
        value: Number(request?.left) + Number(request?.right),
      };
    }

    if (path === "text.upper") {
      const [request] = input.args;
      return {
        provider: "provider-a",
        toolFunction: "text.upper",
        value: String(request?.value).toUpperCase(),
      };
    }

    throw new Error(`Provider A does not implement ${path}`);
  }
}

export class ProviderB extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput) {
    const path = input.path.join(".");

    if (path === "compose.addThenUpper") {
      const ctx = createCodemodeContext({
        codemodeSessionCapability: input.codemodeSessionCapability,
      });
      const [request] = input.args;
      const added = (await ctx.providerA.math.add({
        left: request?.left,
        right: request?.right,
      })) as { value: number };
      const upper = (await ctx.providerA.text.upper({
        value: `sum ${added.value}`,
      })) as { value: string };

      return {
        provider: "provider-b",
        route: "codemode-session-capability",
        toolFunction: "compose.addThenUpper",
        value: upper.value,
      };
    }

    if (path === "text.exclaim") {
      const [request] = input.args;
      return {
        provider: "provider-b",
        toolFunction: "text.exclaim",
        value: `${String(request?.value).toUpperCase()}!`,
      };
    }

    throw new Error(`Provider B does not implement ${path}`);
  }
}

const projectId = "proj__test__codemodesession";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/setup-project-row") {
      await ensureD1Schema(env.DB);
      await upsertProjectRow(env.DB);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/__test/setup-egress-secret") {
      await ensureD1Schema(env.DB);
      await env.PROJECT.getByName(getProjectDurableObjectName(projectId)).createProject({
        projectId,
        slug: "codemode-session-test",
      });
      await ctx.exports.OrpcCapability({ props: { projectId } }).executeCodemodeFunctionCall({
        args: [{ key: "openai", material: "codemode-secret-value" }],
        codemodeSessionCapability: {
          async callFunction() {
            throw new Error("Codemode session tests do not route nested setup calls.");
          },
        },
        functionCallId: crypto.randomUUID(),
        functionPath: ["secrets", "upsert"],
        invocationKind: "rpc",
        path: ["PROJECT", "orpc", "secrets", "upsert"],
        providerPath: ["PROJECT", "orpc"],
      });
      return Response.json({ ok: true });
    }

    return new Response("codemode session test worker");
  },
} satisfies ExportedHandler<Env>;

async function ensureD1Schema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id text primary key not null,
      slug text not null unique,
      custom_hostname text unique,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ingress_routes (
      id text primary key not null,
      host text not null unique,
      project_id text references projects (id) on delete cascade,
      priority integer not null,
      notes text,
      callable_json text not null check (json_valid(callable_json)),
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ingress_routes_host ON ingress_routes (host)`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_ingress_routes_project_id ON ingress_routes (project_id)`,
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_secrets (
      id text primary key not null,
      project_id text not null references projects (id) on delete cascade,
      key text not null,
      material text not null,
      metadata text not null check (json_valid(metadata)),
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique (project_id, key)
    )`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_project_secrets_project_id ON project_secrets (project_id)`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_project_secrets_key ON project_secrets (key)`),
  ]);
}

async function upsertProjectRow(db: D1Database) {
  await db
    .prepare(
      `INSERT INTO projects (id, slug, custom_hostname)
       VALUES (?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug,
         updated_at = current_timestamp`,
    )
    .bind(projectId, "codemode-session-test")
    .run();
}
