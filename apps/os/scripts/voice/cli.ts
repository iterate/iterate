// `pnpm cli voice chat` — a realtime voice conversation multiplexed with an
// itx worker agent. See ./bridge.ts for the design and ./README.md for usage.

import process from "node:process";
import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";
import { runVoiceBridge } from "./bridge.ts";

type ChatOptions = {
  /** Voice provider: grok | openai. Defaults to grok when XAI_API_KEY is set, else openai. */
  provider?: string;
  /** Realtime model. Defaults: grok-voice-latest / gpt-realtime. */
  model?: string;
  /** Voice name. Grok: eve/ara/rex/sal/leo. OpenAI: marin/cedar/alloy. */
  voice?: string;
  /** Project id the worker agent lives in. */
  project?: string;
  /** Create a throwaway project instead of passing --project. */
  createProject?: boolean;
  /**
   * Agent stream path for the worker.
   * @default "/agents/voice-assistant"
   */
  agentPath?: string;
  /** Text REPL mode: type instead of speaking, read instead of listening. */
  text?: boolean;
  /**
   * Forward lane: "auto" forwards every completed user turn to the worker;
   * "tool" forwards only when the voice model calls ask_assistant.
   * @default "auto"
   */
  forward?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or the local dev server. */
  baseUrl?: string;
  /**
   * ffmpeg avfoundation input device for the mic.
   * @default ":0"
   */
  mic?: string;
};

/** Start a voice (or --text) conversation bridged to an itx worker agent. */
export async function chat(options: ChatOptions = {}) {
  const forward = options.forward || "auto";
  if (forward !== "auto" && forward !== "tool") {
    throw new Error(`--forward must be "auto" or "tool", got ${JSON.stringify(forward)}`);
  }
  // Same resolution as `adminConnection` in ../itx.ts (private there): env
  // first, then the live local dev server.
  const baseUrl =
    options.baseUrl ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readLocalDevServerInfo(new URL("../..", import.meta.url).pathname, {
      requireLive: true,
    })?.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  const adminSecret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!adminSecret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");

  await runVoiceBridge({
    provider: options.provider,
    model: options.model,
    voice: options.voice,
    project: options.project,
    createProject: options.createProject,
    agentPath: options.agentPath || "/agents/voice-assistant",
    text: options.text,
    forward,
    baseUrl,
    adminSecret,
    mic: options.mic || ":0",
  });
}
