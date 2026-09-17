// Install the server side of a voice conversation on a project: this
// checkout's voice agent source in the config repo, the OpenAI secret, and the
// agent mounted on a stream. No audio is played. `duplex --setup` and
// `ask --setup` run this first. A conversation from this Mac's microphone and
// speaker is the board firmware's Mac target (apps/kit/firmware/targets/mac),
// which mounts os-next.
//
//   doppler run --config prd -- pnpm cli voicelab setup --project <slug>
//   doppler run --config prd -- pnpm cli voicelab setup --project <slug> --stream-path /agents/voice/<name>
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DynamicWorkerCapability } from "iterate/sdk";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

import {
  installVoiceAgentFromSource,
  VOICE_AGENT_SOURCE_FILES,
  type VoiceAgentRpc,
} from "@iterate-com/voice-agent";
import { connectProject, ensureProjectExists, type VoicelabConnectOptions } from "./connect.ts";
import { voiceAgentConfigRepo } from "./deploy.ts";
import { discardRpcResult, withRpcResult } from "./rpc-ownership.ts";

const DEFAULT_INSTRUCTIONS =
  "You are Iterate, a voice assistant on a small speaker. Keep replies short and " +
  "natural. When asked to count, count steadily and do not stop early.";

/** Options for `pnpm cli voicelab setup`. */
export interface SetupOptions extends Partial<VoicelabConnectOptions> {
  /**
   * Project slug or `prj_` id. Defaults to ITERATE_PROJECT, then `iterate`.
   *
   * Both work because `projects.get` resolves either — slugs are immutable,
   * so a slug handle cannot silently repoint at a different project.
   */
  project?: string;
  /**
   * The stream the conversation lives on, and where its agent is mounted.
   *
   * Defaults to a fresh timestamped path, so each run can be a new
   * conversation or can rejoin an existing one by name.
   */
  streamPath?: string;
  /** What the model is told it is. Defaults to a short assistant prompt. */
  instructions?: string;
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
  /** Classify the answer into mouth shapes for a face-rendering board. */
  visemes?: boolean;
}

/** Type-only: Node consumes the guest contract without importing the Worker runtime. */
type VoiceAgentSetup = Pick<VoiceAgentRpc, "health" | "setupVoiceAgent">;

export async function setup(options: SetupOptions = {}): Promise<void> {
  /* A stable project by default; --project and ITERATE_PROJECT override it. */
  const project = options.project || process.env.ITERATE_PROJECT?.trim() || "iterate";
  const connection = { baseUrl: options.baseUrl, project };
  /* First run on a fresh environment: the default slug is a project that
   * does not exist yet, and a bare `setup` provisions its own home. */
  await ensureProjectExists(connection);
  using itx = await connectProject(connection);

  /* Install this checkout's source so the platform builds the code under test. */
  const install = await installVoiceAgentFromSource(
    voiceAgentConfigRepo(itx),
    readVoiceAgentSource(),
  );
  console.log(
    install.changed
      ? `the repo now carries this checkout's voice agent (${install.commitOid.slice(0, 8)}: ${install.changedPaths.join(", ")})`
      : `the repo already carries this checkout's voice agent (${install.commitOid.slice(0, 8)})`,
  );

  /* The GPT-Live dial spends this project secret. */
  console.log(`openai secret ${await ensureOpenaiSecret(itx)}`);

  using voiceAgent = itx.workers.get(
    install.entrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
  const health = await waitForVoiceAgent(voiceAgent);
  console.log(`voice-agent healthy for ${health.projectId}`);

  const streamPath = options.streamPath || defaultStreamPath();
  if (!streamPath.startsWith("/")) {
    throw new Error(`stream path must be absolute; received ${JSON.stringify(streamPath)}`);
  }
  const result = await withRpcResult(
    voiceAgent.setupVoiceAgent({
      streamPath,
      instructions: options.instructions || DEFAULT_INSTRUCTIONS,
      visemes: options.visemes,
      reinstall: options.reinstall,
    }),
    ({ streamPath: resultPath, warmMs }) => ({ streamPath: resultPath, warmMs }),
  );
  console.log(`stream ${result.streamPath}`);
  console.log(`  warm          processor acknowledged in ${result.warmMs}ms`);
}

/** Wait until the guest answers, retrying a cold build; re-throw the last error verbatim. */
async function waitForVoiceAgent(
  voiceAgent: DynamicWorkerCapability<VoiceAgentSetup>,
): Promise<{ ok: true; projectId: string }> {
  /* Bound cold guest compilation and surface its failure promptly. */
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  for (;;) {
    try {
      return await withRpcResult(voiceAgent.health(), ({ ok, projectId }) => ({
        ok,
        projectId,
      }));
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

/** The subset of the secret capability this command uses. */
interface OpenaiProjectSecret {
  __describe(): Promise<{ created?: boolean; hasMaterial?: boolean }>;
  create(input: { egress: { urls: string[] }; material: string }): Promise<unknown>;
  update(input: { material: string }): Promise<unknown>;
}

/**
 * Make sure the project can reach OpenAI, using the key from the Doppler
 * config this command is already running inside.
 *
 * The config-repo worker deliberately never creates a credential — it only
 * checks and refuses, because a setup routine that mints secrets into a
 * production project on its own initiative is not something you can take
 * back. This is the other side of that line: an operator's own shell, an
 * environment they chose by naming a Doppler config, and an explicit
 * command. The key still never travels through the worker.
 *
 * Existing material is LEFT ALONE. Material is write-only and not
 * comparable, so a "create" over a live secret cannot check whether it
 * matches; silently rotating the OpenAI key of a running project because
 * somebody ran a voice command would be a genuinely bad surprise.
 */
async function ensureOpenaiSecret(itx: unknown): Promise<string> {
  const secretPath = "/secrets/openai";
  const envNames = ["OPENAI_API_KEY", "APP_CONFIG_OPENAI_API_KEY"];
  const egress = ["https://api.openai.com"];
  /* The project handle arrives untyped (the generated client type lives in
   * apps/os); the assertion spells exactly the members this command uses,
   * so a wrong assertion fails loudly at the RPC boundary. */
  const secret = (itx as { secrets: { get(path: string): OpenaiProjectSecret } }).secrets.get(
    secretPath,
  );
  try {
    const described = await withRpcResult(secret.__describe(), ({ created, hasMaterial }) => ({
      created,
      hasMaterial,
    }));
    if (described.created === true && described.hasMaterial === true) return "already set";

    const envName = envNames.find((name) => process.env[name]?.trim());
    const material = envName ? process.env[envName]?.trim() : undefined;
    if (!envName || !material) {
      throw new Error(
        `${secretPath} has no material and none of ${envNames.join("/")} is in this environment. ` +
          `Either run with one set, or create the secret once by hand:\n` +
          `  await itx.secrets.get("${secretPath}").create({ egress: { urls: ${JSON.stringify(egress)} }, material: "<API key>" })`,
      );
    }
    // A secret born without material takes it through update; create would
    // keep the empty material it already has rather than replace it.
    if (described.created === true) {
      await discardRpcResult(secret.update({ material }));
      return `material set from ${envName}`;
    }
    await discardRpcResult(secret.create({ egress: { urls: egress }, material }));
    return `created from ${envName}, pinned to ${egress.join(", ")}`;
  } finally {
    disposeIgnoredRpcResult(secret);
  }
}

/** This checkout's copy of the facet's source, keyed as the installer wants it. */
function readVoiceAgentSource(): Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = path.resolve(here, "../../../../packages/voice-agent/src");
  return Object.fromEntries(
    VOICE_AGENT_SOURCE_FILES.map((file) => [file, fs.readFileSync(path.join(src, file), "utf8")]),
  ) as Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>;
}

/**
 * A fresh conversation, named for when it happened.
 *
 * Minutes, not milliseconds: this is offered for a person to accept or edit,
 * and the point of the default is that it is short enough to retype.
 */
function defaultStreamPath(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
  return `/agents/voice/${stamp}`;
}
