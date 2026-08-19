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
//
// The agent numbers every speaker frame within a conversation, so the report
// can say whether a long call lost any of them. See --report at the bottom:
// that is the proof, and it is arithmetic rather than opinion.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { DynamicWorkerCapability } from "iterate/sdk";
import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

import type VoiceAgentEntrypoint from "../../../../configs/voice-agent/voice-agent.ts";
import { connectProject, resolveVoicelabBaseUrl, type VoicelabConnectOptions } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import { discardRpcResult, withRpcResult } from "./rpc-ownership.ts";
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

/**
 * What to tell the model it is, when the caller does not say.
 *
 * Counting is in here on purpose: a monotonic sequence spoken aloud is the
 * one answer whose gaps a human ear can hear, so it is the utterance every
 * audio bug in this lab has been caught with.
 */
const DEFAULT_INSTRUCTIONS =
  "You are Iterate, a voice assistant on a small speaker. Keep replies short and " +
  "natural. When asked to count, count steadily and do not stop early.";

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
  /** What the model is told it is. Defaults to a short assistant prompt. */
  instructions?: string;
  /** Dial this instead of x.ai. Carries no credential. */
  providerBaseUrl?: string;
  /** Which realtime voice provider the stream's birth certificate names. */
  provider?: "grok" | "openai";
  /** Model and voice overrides for that provider. */
  providerModel?: string;
  providerVoice?: string;
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
  /**
   * Offer the model a hang_up tool: say goodbye, end the call — the baseline
   * proof the tool lane works end to end.
   */
  hangUp?: boolean;
  /**
   * Hold the microphone open for the whole call and let Grok find the turns.
   *
   * OFF BY DEFAULT, BECAUSE THIS CLI IS NOT AN OPEN-MIC CLIENT. It sends audio
   * only while a turn is in progress — the space bar in attended mode, one
   * utterance at a time in unattended mode — and then stops. Server VAD needs
   * the silence AFTER speech to decide the turn ended, so on a stream that
   * simply stops it hears `speech_started` and then waits for ever. Measured:
   * Grok took the audio, detected the speech, and never once answered.
   *
   * The boards ARE open-mic and this is the path they take, so it is worth
   * being able to exercise from here — with a driver that keeps sending.
   */
  openMic?: boolean;
  /**
   * The provider's own turn_detection object as JSON, passed to the birth
   * certificate verbatim — open-mic VAD tuning per stream. Example:
   * '{"type":"server_vad","threshold":0.5,"silence_duration_ms":300}'.
   */
  turnDetection?: string;
  /** Classify the answer into mouth shapes for a face-rendering board. */
  visemes?: boolean;
  /**
   * Thinking fast and slow: arm `note_to_self`, which mints a colleague
   * agent on a fresh `/agents/voice-notes/<conversationId>` stream per
   * conversation and reads its chat replies back into the call.
   */
  colleague?: boolean;
  /**
   * Extra tools for the birth certificate, as a JSON array of
   * `{name, description, parameters?, expression}` entries — appended after
   * the `--hang-up` base tool. Each `expression` is the itx walk the fold
   * validates and the tool runner applies, e.g.
   * `["clients",["get","/clients/stackchan"],"capabilities","face","set"]`.
   */
  tools?: string;
}

/**
 * The RPC contract exported by voice-agent.ts, which no generated client can
 * carry — picked off the REAL entrypoint class rather than hand-mirrored, so
 * there are zero fields to drift, ever. The import is `type`-only, which is
 * what lets it cross the worker/node boundary: type imports are erased by tsx
 * before any resolution (proven both ways), where a VALUE import from
 * config-repo dies at load with ERR_UNSUPPORTED_ESM_URL_SCHEME (F4).
 */
type VoiceAgentSetup = Pick<VoiceAgentEntrypoint, "health" | "setupVoiceAgent">;

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
  /* Resolved before any network call: a missing checkout should fail in a
   * second, not after setting up a conversation nobody can join. */
  const kitDir = options.setupOnly === true ? null : resolveKitDir(options.kitDir);

  const connection = { baseUrl: options.baseUrl, project };
  const baseUrl = resolveVoicelabBaseUrl(connection);
  using itx = await connectProject(connection);

  /* Install the guest BEFORE calling into it: `setupVoiceAgent` lives inside
   * voice-agent.ts, so the file has to be in the repo before there is
   * anything to call — a talk command that only ran setup would work on the
   * machine that had already deployed by hand and fail against a fresh
   * project. Committing identical content is a no-op the platform reports. */
  const install = await installVoiceAgent(itx);
  console.log(
    install.changed
      ? `installed voice-agent.ts (${install.commitOid.slice(0, 8)})`
      : `voice-agent.ts already current (${install.commitOid.slice(0, 8)})`,
  );

  /* Only the secret the chosen provider's dial will spend — setup's gate is
   * per-provider (secretForHost), and a baseUrl seam needs none at all. */
  if (options.providerBaseUrl === undefined) {
    console.log(
      options.provider === "openai"
        ? `openai secret ${await ensureOpenaiSecret(itx)}`
        : `xai secret ${await ensureXaiSecret(itx)}`,
    );
  }

  using voiceAgent = itx.workers.get(
    voiceAgentEntrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
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
  const setup = await withRpcResult(
    voiceAgent.setupVoiceAgent({
      streamPath,
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
      /*
       * THIS CLI SEGMENTS ITS OWN TURNS, in both of its modes.
       *
       * Attended, a person holds the space bar. Unattended, the driver plays
       * one utterance and stops. Either way the audio ENDS rather than going
       * quiet, and server VAD cannot tell a finished sentence from a stalled
       * connection without hearing the silence that follows it. `--open-mic`
       * exists to exercise the boards' path deliberately; it is not the
       * default because on this client it produces a call that hears you and
       * never replies.
       */
      clientTakesTurns: options.openMic !== true,
      ...(options.visemes === true && { visemes: true }),
      ...(options.colleague === true && { colleague: true }),
      ...(options.turnDetection !== undefined && {
        turnDetection: JSON.parse(options.turnDetection) as Record<string, unknown> & {
          type: string;
        },
      }),
      ...(() => {
        const tools = [
          ...(options.hangUp === true
            ? [
                {
                  name: "hang_up",
                  description:
                    "End this call when the user says goodbye or the conversation is " +
                    "clearly over. Say a short goodbye BEFORE calling this; the call " +
                    "ends after you finish speaking.",
                },
              ]
            : []),
          ...(options.tools === undefined
            ? []
            : (JSON.parse(options.tools) as {
                name: string;
                description: string;
                parameters?: Record<string, unknown>;
                expression?: (string | [string, ...unknown[]])[];
              }[])),
        ];
        return tools.length > 0 ? { tools } : {};
      })(),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.providerModel === undefined ? {} : { providerModel: options.providerModel }),
      ...(options.providerVoice === undefined ? {} : { providerVoice: options.providerVoice }),
      ...(options.providerBaseUrl === undefined
        ? {}
        : { providerBaseUrl: options.providerBaseUrl }),
      ...(options.reinstall === undefined ? {} : { reinstall: options.reinstall }),
    }),
    ({ streamPath: resultPath, warmMs }) => ({ streamPath: resultPath, warmMs }),
  );

  console.log(`stream ${setup.streamPath}`);
  console.log(`  warm          processor acknowledged in ${setup.warmMs}ms`);
  if (kitDir === null) return;

  using ingressSecret = itx.secrets.get("/secrets/project-api-key");
  const ingressKey = await withRpcResult(ingressSecret.reveal(), (material) => material);
  if (typeof ingressKey !== "string" || ingressKey.length === 0) {
    throw new Error(
      `the ingress key at /secrets/project-api-key is not readable for ${project}. ` +
        `Every project is born with one, so an unreadable one means this is not the ` +
        `project you think it is.`,
    );
  }

  const binary = buildHostCli(kitDir);
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 15);
  /*
   * EVERY RUN LEAVES ITS EVIDENCE BEHIND, in the repo, without being asked.
   *
   * These used to land in /tmp under six-digit names, which meant the only way
   * to discuss a bad call was to paste terminal scrollback — and scrollback
   * does not contain the audio. One directory per run, gitignored, holding
   * both directions plus the metrics, so "listen to it" and "read the numbers"
   * are both just a path.
   */
  const runDir = path.join(voicelabRunsDir(), `${stamp}-${path.basename(setup.streamPath)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const playback = path.join(runDir, "speaker.wav");
  const micRecord = path.join(runDir, "mic.wav");
  const reportJson = path.join(runDir, "report.json");

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
  console.log(`\n  this run's evidence (gitignored):`);
  console.log(`    ${runDir}\n`);

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
      ...driverArgs(options, minutes, options.openMic === true),
      ...(options.pretendSpeaker === undefined
        ? []
        : ["--pretend-speaker", options.pretendSpeaker]),
      "--speaker-wav",
      playback,
      "--mic-record",
      micRecord,
      "--report-json",
      reportJson,
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

  reportSpeakerContinuity(reportJson);
}

/**
 * THE PROOF, AND WHY IT CAN ONLY BE READ HERE.
 *
 * `spk-frame` is ephemeral, so it is never persisted and no amount of reading
 * the stream afterwards can say how many frames there were. The only witness
 * to what actually arrived is the device that received them, which is why the
 * agent numbers every frame within a conversation and why the host CLI counts
 * the gaps: a missing sequence number is a lost frame, and there is no other
 * way to distinguish "the answer was short" from "the answer was cut".
 *
 * Printed from the report rather than asserted, because a long conversation
 * has many legitimate reasons to be interesting and only one to be wrong.
 */
function reportSpeakerContinuity(reportJson: string): void {
  let summary: Record<string, unknown>;
  try {
    const report = JSON.parse(fs.readFileSync(reportJson, "utf8")) as {
      summary?: Record<string, unknown>;
    };
    summary = report.summary ?? {};
  } catch (error) {
    console.log(`\n  no report at ${reportJson} (${String(error).slice(0, 80)})`);
    return;
  }
  const number = (key: string): number | undefined =>
    typeof summary[key] === "number" ? (summary[key] as number) : undefined;
  const received = number("spkFramesReceived");
  const gaps = number("spkSeqGaps");
  const missing = number("spkSeqMissing");
  const regressions = number("spkSeqRegressions");
  const decodeFailures = number("spkDecodeFailures");

  console.log(`\n  SPEAKER CONTINUITY`);
  if (gaps === undefined) {
    /* Said plainly rather than reported as zero: a binary too old to count
     * gaps reports no gaps, and that reads exactly like a clean run. */
    console.log(
      `    this host CLI does not count sequence gaps, so this run proves nothing ` +
        `about lost frames. Rebuild apps/kit/firmware.`,
    );
    return;
  }
  if ((received ?? 0) === 0) {
    /*
     * NOTHING ARRIVED, SO NOTHING IS PROVEN. Zero gaps out of zero frames is
     * vacuously true and prints as a tick, which is precisely how a totally
     * silent call reported itself as a clean one on this instrument's first
     * run. A proof that cannot fail is not a proof.
     */
    console.log(`    no speaker frames arrived at all — this call was silent.`);
    console.log(`\n    ✗ nothing to measure. ${reportJson}`);
    return;
  }
  console.log(`    frames received      ${received}`);
  console.log(`    sequence gaps        ${gaps}${gaps === 0 ? "  ✓" : ""}`);
  console.log(`    frames missing       ${missing ?? "?"}`);
  console.log(`    out of order/dupes   ${regressions ?? "?"}`);
  console.log(`    decode failures      ${decodeFailures ?? "?"}`);
  if (gaps === 0 && (decodeFailures ?? 0) === 0) {
    console.log(`\n    ✓ every speaker frame the agent numbered arrived and decoded.`);
  } else {
    console.log(`\n    ✗ this call lost audio. ${reportJson}`);
  }
}

/** Wait until the guest answers, retrying a cold build; re-throw the last error verbatim. */
async function waitForVoiceAgent(
  voiceAgent: DynamicWorkerCapability<VoiceAgentSetup>,
): Promise<{ ok: true; projectId: string }> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
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
      await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_MS));
    }
  }
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
export async function ensureXaiSecret(itx: unknown): Promise<string> {
  return await ensureProviderSecret(itx, {
    path: XAI_SECRET,
    envNames: [XAI_ENV],
    egress: XAI_EGRESS,
  });
}

/** The OpenAI twin of the xAI secret, for the voice provider comparison. */
export async function ensureOpenaiSecret(itx: unknown): Promise<string> {
  return await ensureProviderSecret(itx, {
    path: "/secrets/openai",
    envNames: ["OPENAI_API_KEY", "APP_CONFIG_OPENAI_API_KEY"],
    egress: ["https://api.openai.com"],
  });
}

/** The subset of the secret capability this command uses. */
interface XaiSecret {
  __describe(): Promise<{ created?: boolean; hasMaterial?: boolean }>;
  create(input: { egress: { urls: string[] }; material: string }): Promise<unknown>;
  update(input: { material: string }): Promise<unknown>;
}

async function ensureProviderSecret(
  itx: unknown,
  args: { path: string; envNames: string[]; egress: string[] },
): Promise<string> {
  const secret = (itx as { secrets: { get(path: string): XaiSecret } }).secrets.get(args.path);
  try {
    const described = await withRpcResult(secret.__describe(), ({ created, hasMaterial }) => ({
      created,
      hasMaterial,
    }));
    if (described.created === true && described.hasMaterial === true) return "already set";

    const envName = args.envNames.find((name) => process.env[name]?.trim());
    const material = envName === undefined ? undefined : process.env[envName]?.trim();
    if (!material || envName === undefined) {
      throw new Error(
        `${args.path} has no material and none of ${args.envNames.join("/")} is in this environment. ` +
          `Either run with one set, or create the secret once by hand:\n` +
          `  await itx.secrets.get("${args.path}").create({ egress: { urls: ${JSON.stringify(args.egress)} }, material: "<API key>" })`,
      );
    }
    // A secret born without material takes it through update; create would
    // keep the empty material it already has rather than replace it.
    if (described.created === true) {
      await discardRpcResult(secret.update({ material }));
      return `material set from ${envName}`;
    }
    await discardRpcResult(secret.create({ egress: { urls: args.egress }, material }));
    return `created from ${envName}, pinned to ${args.egress.join(", ")}`;
  } finally {
    disposeIgnoredRpcResult(secret);
  }
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
export function resolveKitDir(explicit?: string): string {
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
export function driverArgs(
  options: TalkOptions,
  minutes: number,
  /** Attended open mic: the C streams continuously and the server's VAD owns
   * the turns. Off, the space bar owns them. Must match the stream's
   * certificate, which is why talk passes its own --open-mic here. */
  openMic = false,
): string[] {
  if (options.converse === undefined) {
    return [
      ...(options.pretendSpeaker === undefined ? ["--live-audio"] : []),
      "--live-mic",
      openMic ? "--open-mic" : "--push-to-talk",
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
  const args = [
    ...(options.pretendSpeaker === undefined ? ["--live-audio"] : []),
    "--converse",
    String(options.converse),
    "--utterance-dir",
    options.utteranceDir,
  ];
  if (options.colleagueEvery !== undefined) {
    args.push("--colleague-every", String(options.colleagueEvery));
  }
  return args;
}

/** Incrementally build the host CLI from the current source tree. */
export function buildHostCli(kitDir: string): string {
  const firmware = path.join(kitDir, "firmware");
  const build = path.join(firmware, ".build", "voicelab");
  const binary = path.join(build, "iterate-kit-cli");

  console.log(`building ${binary}…`);
  runInherited("cmake", ["-S", firmware, "-B", build, "-DCMAKE_BUILD_TYPE=Debug"]);
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

export async function promptWithDefault(label: string, defaultValue: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question(`${label} [${defaultValue}]: `)).trim() || defaultValue;
  } finally {
    input.close();
  }
}

/**
 * Where a run's artifacts go: `.voicelab-runs/` at the repo root, gitignored.
 *
 * At the ROOT rather than under apps/os, because a run is about the whole
 * system — the C client, the stream, the facet — and burying it under one app
 * implies it belongs to that app.
 */
export function voicelabRunsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../.voicelab-runs");
}

/**
 * Run with the terminal attached, and report what happened verbatim.
 *
 * `stdio: "inherit"` is load-bearing rather than a convenience: the C puts the
 * terminal into raw mode for hold-to-talk and cannot do that through a pipe.
 */
export function runInherited(command: string, args: string[], env = process.env): void {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`);
}
