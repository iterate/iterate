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

const DEFAULT_PROJECT = "prj_698c23da57f84d92a9ba5dc959efebec";
const DEFAULT_MINUTES = 30;

/** Options for `pnpm cli voicelab talk`. */
export interface TalkOptions extends Partial<VoicelabConnectOptions> {
  // Consumed by `cli.ts` BEFORE this runs: the config supplies the base URL
  // and the admin secret, so the process is already inside `doppler run` by
  // the time any of this executes. Declared here so it reaches --help and so
  // passing it does not read as an unknown flag.
  /** Doppler environment, for example preview_3. Prompted on a TTY. */
  environment?: string;
  /** Project id (prj_…). Prompted with a default on a TTY. */
  project?: string;
  /** Conversation stream. Defaults to a fresh /agents/voice/* path. */
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
}

interface VoiceAgentSetup {
  setupVoiceAgent(options?: { streamPath?: string }): Promise<{
    streamPath: string;
    created: string[];
    alreadyThere: string[];
  }>;
}

export async function talk(options: TalkOptions = {}) {
  const project =
    options.project ??
    (await promptWithDefault("Project", process.env.ITERATE_PROJECT?.trim() || DEFAULT_PROJECT));
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

  // The generated Cap'n Web client cannot carry a userspace worker's methods;
  // this is the RPC contract exported by the exact source ref above.
  using voiceAgent = itx.workers.get(
    voiceAgentEntrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
  const setup = await voiceAgent.setupVoiceAgent(
    options.streamPath === undefined ? {} : { streamPath: options.streamPath },
  );

  console.log(`stream ${setup.streamPath}`);
  for (const item of setup.created) console.log(`  created       ${item}`);
  for (const item of setup.alreadyThere) console.log(`  already there ${item}`);
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
    return ["--live-audio", "--live-mic", "--push-to-talk", "--minutes", String(minutes)];
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
