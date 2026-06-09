import type { Client } from "sqlfu";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { AuthenticatedSession } from "@iterate-com/auth/server";
import type { Stream } from "@iterate-com/streams/workers/durable-objects/stream";
import manifest, { type AppConfig } from "~/app.ts";
import type { Principal } from "~/auth/principal.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { CloudflareArtifactsBinding } from "~/domains/repos/artifacts.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  db: Client;
  doCatalog?: D1Database;
  principal?: Principal | null;
  iterateAuthSession?: AuthenticatedSession | null;
  log: SharedRequestLogger;
  projectHostnameBases: string[];
  waitUntil?: (promise: Promise<unknown>) => void;
  workerScriptName?: string;
  rawRequest?: Request;
  agent?: DurableObjectNamespace<AgentDurableObject>;
  artifacts?: CloudflareArtifactsBinding;
  loader?: WorkerLoader;
  codemodeSession?: DurableObjectNamespace<CodemodeSession>;
  projectDurableObjectNamespace?: DurableObjectNamespace<ProjectDurableObject>;
  repo?: DurableObjectNamespace<RepoDurableObject>;
  slackAgent?: DurableObjectNamespace<SlackAgentDurableObject>;
  slackIntegration?: DurableObjectNamespace<SlackIntegrationDurableObject>;
  stream?: DurableObjectNamespace<Stream>;
  workerExports?: Cloudflare.Exports;
  callableEnv?: Record<string, unknown>;
  projectAccess?: {
    projectId: string;
  };
  projectScope?: {
    project: {
      id: string;
      slug: string;
      custom_hostname?: string | null;
      created_at: string;
      updated_at: string;
    };
    projectSlugOrId: string;
  };
}
