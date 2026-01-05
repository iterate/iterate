/**
 * Pi Coding Agent integration for the daemon.
 * Each durable stream can have an associated Pi agent session.
 */

import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  codingTools,
  SessionManager,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { createCustomTools } from "./custom-tools.ts";

// appendMessage is injected to avoid circular dependency with index.ts
type AppendMessageFn = (agentId: string, content: unknown, source: string, metadata?: Record<string, unknown>) => Promise<{ offset: string }>;
let appendMessageFn: AppendMessageFn | null = null;

export function setAppendMessage(fn: AppendMessageFn): void {
  appendMessageFn = fn;
}

export type PiStreamMessage =
  | AgentSessionEvent
  | { type: "user_prompt"; text: string }
  | { type: "assistant_text"; text: string; complete: boolean }
  | { type: "assistant_thinking"; text: string }
  | { type: "tool_call"; name: string; input: unknown; toolCallId: string }
  | { type: "tool_result"; name: string; output: string; isError: boolean; toolCallId: string }
  | { type: "agent_message"; from: string; text: string; timestamp: string }
  | { type: "error"; message: string };

let sharedAuthStorage: AuthStorage | null = null;
let sharedModelRegistry: ModelRegistry | null = null;

function getAuthStorage(): AuthStorage {
  if (!sharedAuthStorage) {
    sharedAuthStorage = new AuthStorage("/tmp/daemon-pi-auth.json");
    if (process.env.ANTHROPIC_API_KEY) {
      sharedAuthStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY);
      console.log("Set Anthropic API key from environment");
    }
    if (process.env.OPENAI_API_KEY) {
      sharedAuthStorage.setRuntimeApiKey("openai", process.env.OPENAI_API_KEY);
    }
  }
  return sharedAuthStorage;
}

function getModelRegistry(): ModelRegistry {
  if (!sharedModelRegistry) {
    sharedModelRegistry = new ModelRegistry(getAuthStorage());
  }
  return sharedModelRegistry;
}

export async function createPiSession(streamId: string): Promise<AgentSession> {
  if (!appendMessageFn) throw new Error("appendMessage not initialized - call setAppendMessage first");
  
  const customTools = createCustomTools(streamId, appendMessageFn);
  const cwd = process.cwd();

  const model = getModel("anthropic", "claude-sonnet-4-20250514");
  if (!model) throw new Error("Claude Sonnet 4 model not found");

  console.log(`[Pi] Creating session with model: ${model.id}`);

  const registry = getModelRegistry();
  const availableModels = registry.getAvailable();
  console.log(`[Pi] Available models: ${availableModels.map(m => `${m.provider}/${m.id}`).join(", ")}`);
  const apiKey = await registry.getApiKey(model);
  console.log(`[Pi] API key for ${model.id}: ${apiKey ? `${apiKey.substring(0, 10)}...` : "NOT FOUND"}`);

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",
    authStorage: getAuthStorage(),
    modelRegistry: getModelRegistry(),
    systemPrompt: "You are a helpful coding assistant. Be concise in your responses.",
    tools: codingTools,
    customTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 3 },
    }),
  });

  subscribeToEvents(streamId, session);
  return session;
}

function subscribeToEvents(streamId: string, session: AgentSession): void {
  console.log(`[Pi] Subscribing to events for stream: ${streamId}`);

  session.subscribe(async (event: AgentSessionEvent) => {
    console.log(`[Pi] Event for ${streamId}:`, event.type, JSON.stringify(event).substring(0, 200));

    if (appendMessageFn) {
      await appendMessageFn(
        streamId,
        event satisfies PiStreamMessage,
        event.type === "message_start" || event.type === "message_end" || event.type === "message_update"
          ? ((event as any).message?.role === "user" ? "user" : "assistant")
          : "system"
      );
    }
  });
}

export async function promptPiSession(session: AgentSession, text: string): Promise<void> {
  console.log(`[Pi] Sending prompt: "${text.substring(0, 50)}..."`);
  try {
    await session.prompt(text);
    console.log(`[Pi] Prompt completed successfully`);
  } catch (error) {
    console.error(`[Pi] Prompt failed:`, error);
    throw error;
  }
}

export function disposePiSession(session: AgentSession): void {
  session.dispose();
}
