// Hold a voice conversation from this Mac: real microphone in, speakers out,
// hold-to-talk. No ESP32 involved.
//
//   pnpm cli voicelab talk                # asks which environment and project
//   pnpm cli voicelab talk --minutes 20
//   pnpm cli voicelab talk --setup-only   # install the server side, play nothing
//
// The C this drives is the SAME C the device runs — the same playout
// decisions, the same bounded rings, the same capability surface, with a Mac's
// audio hardware instead of the board's. If it sounds right here and wrong on
// the device, the fault is in the board's analogue path; if it sounds wrong
// here too, it is in code you can iterate on in seconds.
//
// Everything the conversation needs on the server side is installed by the
// config repo's own `setupVoiceAgent`, so a fresh project needs no manual
// preparation and a second run changes nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { connectProject, resolveVoicelabBaseUrl, type VoicelabConnectOptions } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";

/*
 * PRODUCTION, AND A PROJECT THAT EXISTS TOMORROW.
 *
 * This defaulted to a preview slot and an opaque project id, and that combination
 * cost a real debugging session: a call was made, three turns went unanswered,
 * and by the time the stream was opened to find out why, `preview_3` answered
 * 503 to everything. Preview environments hold a roughly three-hour lease and
 * are then reclaimed — so the evidence for a bug found on one has a shelf life
 * shorter than the bug report. `voice-test` on production does not evaporate,
 * and a slug is something you can recognise in a prompt.
 *
 * `--project` and ITERATE_PROJECT still point this anywhere; the default is
 * about where an unattended answer lands, which should be the boring place.
 */
const DEFAULT_PROJECT = "voice-test";
const DEFAULT_MINUTES = 30;
const XAI_SECRET = "/secrets/xai";
/**
 * The provider key in the Doppler config this command already runs inside.
 *
 * Named exactly as Doppler has it so nobody has to map one name to another;
 * see docs/devops-cloudflare-doppler.md for where env config comes from.
 */
const XAI_ENV = "APP_CONFIG_X_AI_API_KEY";
/** Where the key may be sent. A secret pinned nowhere can be sent anywhere. */
const XAI_EGRESS = ["https://api.x.ai"];

/** Options for `pnpm cli voicelab talk`. */
export interface TalkOptions extends Partial<VoicelabConnectOptions> {
  // Consumed by `cli.ts` BEFORE this runs: the config supplies the base URL
  // and the admin secret, so the process is already inside `doppler run` by
  // the time any of this executes. Declared here so it reaches --help and so
  // passing it does not read as an unknown flag.
  /** Doppler environment, for example preview_3. Prompted on a TTY. */
  environment?: string;
  /**
   * Project slug or `prj_` id. Prompted with a default on a TTY.
   *
   * Both work because `projects.get` resolves either — slugs are immutable,
   * so a slug handle cannot silently repoint at a different project.
   */
  project?: string;
  /**
   * The stream this conversation lives on, and where its agent is mounted.
   *
   * Prompted with a fresh timestamped default on a TTY, so each run can be a
   * new conversation or can rejoin an existing one by name. A path you can
   * type and remember matters more than uniqueness here: the whole reason to
   * choose it is to go back and look at what happened.
   */
  streamPath?: string;
  /** Wall-clock limit for the session. */
  minutes?: number;
  /** Where apps/kit lives, when that is not this worktree. */
  kitDir?: string;
  /** Install and report the server side, then stop without starting audio. */
  setupOnly?: boolean;
  /**
   * Run unattended for this many minutes instead of hold-to-talk.
   *
   * The driver takes the turns itself from recorded utterances, so an
   * hour-long conversation needs nobody at the keyboard — which is the only
   * way the long-run behaviour ever actually gets measured.
   */
  converse?: number;
  /** PCM16 mono 16 kHz WAVs the unattended driver speaks. Required by --converse. */
  utteranceDir?: string;
  /** Force a back-office consultation every Nth utterance. */
  colleagueEvery?: number;
  /**
   * Play into this file instead of this Mac's speaker.
   *
   * The SAME converter either way — same ring, same pull, same starvation
   * accounting — so a session run this way exercises the path a listener
   * depends on while making no sound and needing nobody at the machine. The
   * recording it leaves is the true timeline, silence included.
   */
  pretendSpeaker?: string;
}

interface VoiceAgentSetup {
  health(): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }>;
  setupVoiceAgent(options?: { streamPath?: string }): Promise<{
    streamPath: string;
    created: string[];
    alreadyThere: string[];
    /** The processor's own acknowledgement that it is awake and sees the brief. */
    warm: { ok: boolean; ms: number };
  }>;
}

/**
 * How long to keep waiting for the guest worker to build.
 *
 * A cold dynamic-worker build is the slowest thing in this command, and a
 * compile error in the committed file surfaces only here. Fifteen seconds:
 * long enough for a cold build, short enough that a broken build is on the
 * screen while you are still looking at it. Waiting a minute to be told the
 * file does not compile is a minute nobody gets back.
 */
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_RETRY_MS = 1_000;

export async function talk(options: TalkOptions = {}) {
  const project =
    options.project ??
    (await promptWithDefault(
      "Project (slug or id)",
      process.env.ITERATE_PROJECT?.trim() || DEFAULT_PROJECT,
    ));
  const minutes = options.minutes ?? DEFAULT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`--minutes must be greater than zero; received ${JSON.stringify(minutes)}`);
  }
  // Resolved before any network call: a missing checkout should fail in a
  // second, not after setting up a conversation nobody can join.
  const kitDir = options.setupOnly === true ? null : resolveKitDir(options.kitDir);

  const connection = { baseUrl: options.baseUrl, project };
  const baseUrl = resolveVoicelabBaseUrl(connection);
  using itx = await connectProject(connection);

  /*
   * Install the guest BEFORE calling into it. `setupVoiceAgent` lives inside
   * voice-agent.ts, so the file has to be in the config repo before there is
   * anything to call — a talk command that only ran setup would work on the
   * machine that had already deployed by hand and fail against a fresh
   * project. Committing identical content is a no-op the platform reports.
   */
  const install = await installVoiceAgent(itx);
  console.log(
    install.changed
      ? `installed voice-agent.ts (${install.commitOid.slice(0, 8)})`
      : `voice-agent.ts already current (${install.commitOid.slice(0, 8)})`,
  );

  console.log(`xai secret ${await ensureXaiSecret(itx)}`);

  // The generated Cap'n Web client cannot carry a userspace worker's methods;
  // this is the RPC contract exported by the exact source ref above.
  using voiceAgent = itx.workers.get(
    voiceAgentEntrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
  // Wait for the guest to actually build before anything with consequences.
  const health = await waitForVoiceAgent(voiceAgent);
  console.log(`voice-agent healthy for ${health.projectId}`);

  /*
   * Asked for, not invented. A generated UUID makes every run a conversation
   * nobody can find again; a name you chose is one you can point setup, the
   * agent and a later look at the stream all at.
   */
  const streamPath = options.streamPath ?? (await promptWithDefault("Stream", defaultStreamPath()));
  if (!streamPath.startsWith("/")) {
    throw new Error(`stream path must be absolute; received ${JSON.stringify(streamPath)}`);
  }
  const setup = await voiceAgent.setupVoiceAgent({ streamPath });

  console.log(`stream ${setup.streamPath}`);
  for (const item of setup.created) console.log(`  created       ${item}`);
  for (const item of setup.alreadyThere) console.log(`  already there ${item}`);
  console.log(`  warm          processor acknowledged in ${setup.warm.ms}ms`);
  if (kitDir === null) return;

  const ingressKey = await itx.secrets.get("/secrets/project-api-key").reveal();
  if (typeof ingressKey !== "string" || ingressKey.length === 0) {
    throw new Error(
      `the ingress key at /secrets/project-api-key is not readable for ${project}. ` +
        `Every project is born with one, so an unreadable one means this is not the ` +
        `project you think it is.`,
    );
  }

  const binary = buildIfAbsent(kitDir);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(8, 14);
  const playback = `/tmp/iterate-talk-${stamp}-speaker.wav`;
  const micRecord = `/tmp/iterate-talk-${stamp}-mic.wav`;

  console.log(`\n  ${baseUrl} · ${project}`);
  if (options.converse === undefined) {
    console.log(`\n  HOLD space to talk, release to send, q to hang up.`);
    console.log(`  A tap does nothing: a terminal has no key-up event, so release is`);
    console.log(`  inferred from the key repeat stopping.`);
    console.log(`  If micIn stays at 0 in the pulse line, macOS denied the microphone —`);
    console.log(`  that is the only symptom it gives.`);
  } else {
    console.log(`\n  unattended: ${String(options.converse)} minutes, taking its own turns.`);
  }
  console.log(`\n  recorded both directions, so a failure can be listened to:`);
  console.log(`    speaker ${playback}`);
  console.log(`    mic     ${micRecord}\n`);

  runInherited(
    binary,
    [
      // NO HYPHEN. The name becomes the capability mount `kit.<name>`, and a
      // hyphen there is rejected as an invalid argument — the mount fails
      // about five seconds in with `capnweb=-1` and a message that says
      // nothing about names. The shell script this replaced used `mac-$STAMP`
      // and had never once connected.
      "--name",
      `mac${stamp}`,
      "--stream-path",
      setup.streamPath,
      ...driverArgs(options, minutes),
      ...(options.pretendSpeaker === undefined
        ? []
        : ["--pretend-speaker", options.pretendSpeaker]),
      "--speaker-wav",
      playback,
      "--mic-record",
      micRecord,
      "--report-json",
      `/tmp/iterate-talk-${stamp}.json`,
    ],
    {
      ...process.env,
      // These three names are the binary's contract, not ours: cli_options.c
      // reads exactly these. Inventing friendlier ones makes the CLI exit
      // demanding a --project-id nobody omitted, which is precisely how this
      // command failed the first time it was written.
      ITERATE_OS_BASE_URL: baseUrl,
      ITERATE_PROJECT_API_KEY: ingressKey,
      ITERATE_PROJECT_ID: project,
    },
  );
}

/**
 * Wait until the guest worker answers, retrying a cold build.
 *
 * The first call into a dynamic worker builds it, so it is both the slowest
 * and the only one that can fail for reasons that have nothing to do with
 * what was asked. Doing that here means a build failure is reported as a
 * build failure, and that the calls after it — which append events and start
 * conversations — are never the ones absorbing a cold start.
 *
 * The last error is re-thrown verbatim on timeout. A summary would hide the
 * compile error that is almost always the actual answer.
 */
async function waitForVoiceAgent(
  voiceAgent: DynamicWorkerCapability<VoiceAgentSetup>,
): Promise<{ ok: true; projectId: string; xaiSecretReady: boolean }> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  let lastError: unknown;
  for (;;) {
    attempts++;
    try {
      return await voiceAgent.health();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      if (attempts === 1) console.log("waiting for the voice-agent worker to build…");
      await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
    }
  }
  throw new Error(
    `voice-agent did not become healthy within ${String(HEALTH_TIMEOUT_MS / 1000)}s ` +
      `after ${String(attempts)} attempts. This is usually a compile error in the ` +
      `committed voice-agent.ts. The last error was:\n${String(lastError)}`,
  );
}

/** The subset of the secret capability this command uses. */
interface XaiSecret {
  __describe(): Promise<{ created?: boolean; hasMaterial?: boolean }>;
  create(input: { egress: { urls: string[] }; material: string }): Promise<unknown>;
  update(input: { material: string }): Promise<unknown>;
}

/**
 * Make sure the project can reach the provider, using the key from the
 * Doppler config this command is already running inside.
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
 * matches; silently rotating the provider key of a running project because
 * somebody ran a voice command would be a genuinely bad surprise.
 */
async function ensureXaiSecret(itx: unknown): Promise<string> {
  const secret = (itx as { secrets: { get(path: string): XaiSecret } }).secrets.get(XAI_SECRET);
  const described = await secret.__describe();
  if (described.created === true && described.hasMaterial === true) return "already set";

  const material = process.env[XAI_ENV]?.trim();
  if (!material) {
    throw new Error(
      `${XAI_SECRET} has no material and ${XAI_ENV} is not in this environment. ` +
        `Either run inside a Doppler config that has it, or create the secret once by hand:\n` +
        `  await itx.secrets.get("${XAI_SECRET}").create({ egress: { urls: ${JSON.stringify(XAI_EGRESS)} }, material: "<xAI API key>" })`,
    );
  }
  // A secret born without material takes it through update; create would
  // keep the empty material it already has rather than replace it.
  if (described.created === true) {
    await secret.update({ material });
    return `material set from ${XAI_ENV}`;
  }
  await secret.create({ egress: { urls: XAI_EGRESS }, material });
  return `created from ${XAI_ENV}, pinned to ${XAI_EGRESS.join(", ")}`;
}

/**
 * Find the C.
 *
 * `apps/kit` belongs to this monorepo but not necessarily to this worktree —
 * the firmware and the server side are usually worked on side by side in two
 * checkouts. Resolution order is what you asked for, then this worktree, then
 * a sibling that has it. Every candidate tried is named in the failure,
 * because "cannot find the CLI" without saying where it looked is the class of
 * message that cost an evening on this project already.
 */
function resolveKitDir(explicit?: string): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const worktree = path.resolve(here, "../../../..");
  const candidates = [
    explicit,
    process.env.ITERATE_KIT_DIR?.trim() || undefined,
    path.join(worktree, "apps/kit"),
    path.join(path.dirname(worktree), "c-capabilities/apps/kit"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "firmware/CMakeLists.txt"))) return candidate;
  }
  throw new Error(
    `no apps/kit holding firmware/CMakeLists.txt. Looked in:\n` +
      candidates.map((candidate) => `  ${candidate}`).join("\n") +
      `\nPass --kit-dir or set ITERATE_KIT_DIR.`,
  );
}

/**
 * Who takes the turns: a person at the terminal, or the unattended driver.
 *
 * These two cannot both run — they would each end the other's turn and the
 * report would describe a conversation neither of them had — so choosing one
 * is a branch rather than a set of flags that happen not to collide.
 */
function driverArgs(options: TalkOptions, minutes: number): string[] {
  if (options.converse === undefined) {
    return [
      ...(options.pretendSpeaker === undefined ? ["--live-audio"] : []),
      "--live-mic",
      "--push-to-talk",
      "--minutes",
      String(minutes),
    ];
  }
  if (options.utteranceDir === undefined) {
    throw new Error(
      "--converse needs --utterance-dir: a driver with no utterances holds the call " +
        "open and says nothing, which reads in the report as a device that never answered.",
    );
  }
  const args = ["--converse", String(options.converse), "--utterance-dir", options.utteranceDir];
  if (options.colleagueEvery !== undefined) {
    args.push("--colleague-every", String(options.colleagueEvery));
  }
  return args;
}

/** Build the host CLI on first use. A stale build is the caller's to clear. */
function buildIfAbsent(kitDir: string): string {
  const firmware = path.join(kitDir, "firmware");
  const build = path.join(firmware, "build-host");
  const binary = path.join(build, "iterate-kit-cli");
  if (fs.existsSync(binary)) return binary;

  console.log(`building ${binary}…`);
  runInherited("cmake", ["-S", firmware, "-B", build]);
  runInherited("cmake", ["--build", build, "--target", "iterate-kit-cli", "-j8"]);
  return binary;
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

async function promptWithDefault(label: string, defaultValue: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(`${label} [${defaultValue}]: `)).trim() || defaultValue;
  } finally {
    input.close();
  }
}

/**
 * Run with the terminal attached, and report what happened verbatim.
 *
 * `stdio: "inherit"` is load-bearing rather than a convenience: the C puts the
 * terminal into raw mode for hold-to-talk and cannot do that through a pipe.
 */
function runInherited(command: string, args: string[], env = process.env): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`);
}
