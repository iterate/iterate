import type { Client } from "sqlfu";
import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import type { auth } from "@clerk/tanstack-react-start/server";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import manifest, { type AppConfig } from "~/app.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { ProjectDurableObject } from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { CloudflareArtifactsBinding } from "~/domains/repos/artifacts.ts";
import type { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import type { SlackAgentDurableObject } from "~/domains/slack/durable-objects/slack-agent-durable-object.ts";
import type { SlackIntegrationDurableObject } from "~/domains/slack/durable-objects/slack-integration-durable-object.ts";
import type { VoiceAgentDurableObject } from "~/domains/voice-agents/durable-objects/voice-agent-durable-object.ts";

export type ClerkAuth = Awaited<ReturnType<typeof auth>>;

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  db: Client;
  doCatalog?: D1Database;
  auth?: ClerkAuth;
  log: SharedRequestLogger;
  projectHostnameBases: string[];
  waitUntil?: (promise: Promise<unknown>) => void;
  workerScriptName?: string;
  rawRequest?: Request;
  agent?: DurableObjectNamespace<AgentDurableObject>;
  voiceAgent?: DurableObjectNamespace<VoiceAgentDurableObject>;
  artifacts?: CloudflareArtifactsBinding;
  loader?: WorkerLoader;
  codemodeSession?: DurableObjectNamespace<CodemodeSession>;
  projectDurableObjectNamespace?: DurableObjectNamespace<ProjectDurableObject>;
  repo?: DurableObjectNamespace<RepoDurableObject>;
  slackAgent?: DurableObjectNamespace<SlackAgentDurableObject>;
  slackIntegration?: DurableObjectNamespace<SlackIntegrationDurableObject>;
  stream?: DurableObjectNamespace<StreamDurableObject>;
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
      external_egress_proxy_url?: string | null;
      created_at: string;
      updated_at: string;
    };
    projectSlugOrId: string;
  };
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}
