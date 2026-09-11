// Hold a voice conversation from this Mac: real microphone in, speakers out,
// hold-to-talk (or an open microphone). No ESP32 involved. GPT-Live on the
// far end, delegating to a fast Astra with exec_typescript on the project.
//
//   pnpm cli voicelab talk                # asks which environment and project
//   pnpm cli voicelab talk --auto         # defaults for both prompts: default project, fresh stream
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

import {
  installVoiceAgentFromSource,
  VOICE_AGENT_SOURCE_FILES,
  voiceAgentEntrypointRef,
  voiceAgentFacetRef,
  type VoiceAgentRpc,
} from "@iterate-com/voice-agent";
import {
  connectProject,
  ensureProjectExists,
  resolveVoicelabBaseUrl,
  type VoicelabConnectOptions,
} from "./connect.ts";
import { voiceAgentConfigRepo } from "./deploy.ts";
import { discardRpcResult, withRpcResult } from "./rpc-ownership.ts";

/*
 * PRODUCTION, AND A PROJECT THAT EXISTS TOMORROW.
 *
 * This defaulted to a preview slot and an opaque project id, and that combination
 * cost a real debugging session: a call was made, three turns went unanswered,
 * and by the time the stream was opened to find out why, `preview_3` answered
 * 503 to everything. Preview environments hold a roughly three-hour lease and
 * are then reclaimed — so the evidence for a bug found on one has a shelf life
 * shorter than the bug report. A production project does not evaporate, and a
 * slug is something you can recognise in a prompt.
 *
 * `iterate` because voice belongs on the project people already live in, not
 * in a lab annex: a bare run should land where its notes, its
 * tools and its transcripts are part of the same working world. A missing
 * slug is created on first run (ensureProjectExists), so the default works
 * on a fresh environment too.
 *
 * `--project` and ITERATE_PROJECT still point this anywhere.
 */
const DEFAULT_PROJECT = "iterate";
const DEFAULT_MINUTES = 30;

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
   * Accept every prompt's default without asking: the default project and a
   * fresh timestamped stream. The two prompts exist so a run can rejoin a
   * conversation by name; when the answer is always enter-enter, this is the
   * flag that says so.
   */
  auto?: boolean;
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
  /** Install the subscription under a fresh key even if an identical one exists. */
  reinstall?: boolean;
  /**
   * Offer the model a hang_up tool: say goodbye, end the call — the baseline
   * proof the tool path works end to end. ON BY DEFAULT — every stream is
   * born able to end its own call; pass `--hang-up false` to withhold it.
   */
  hangUp?: boolean;
  /**
   * Hold the microphone open for the whole call instead of holding SPACE.
   *
   * A DRIVER flag, not a certificate one: GPT-Live takes every turn itself
   * and answers a button-release-shaped stop just as it answers silence
   * (measured 475 ms after the last frame, live-probe 2026-09-10), so the
   * stream carries no turn posture any more. Off by default because this
   * Mac's speaker feeds its microphone; the boards have echo cancellation.
   */
  openMic?: boolean;
  /** Classify the answer into mouth shapes for a face-rendering board. */
  visemes?: boolean;
  /**
   * Extra tools for the birth certificate, as a JSON array of
   * `{name, description, parameters?}` entries — appended after the
   * `--hang-up` base tool. The certificate accepts only names the agent
   * knows how to be (today: `hang_up`); everything else the backend does
   * through `exec_typescript`.
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
type VoiceAgentSetup = Pick<VoiceAgentRpc, "health" | "setupVoiceAgent">;

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
  const defaultProject = process.env.ITERATE_PROJECT?.trim() || DEFAULT_PROJECT;
  const project =
    options.project ??
    (options.auto === true
      ? defaultProject
      : await promptWithDefault("Project (slug or id)", defaultProject));
  const minutes = options.minutes ?? DEFAULT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`--minutes must be greater than zero; received ${JSON.stringify(minutes)}`);
  }
  /* Resolved before any network call: a missing checkout should fail in a
   * second, not after setting up a conversation nobody can join. */
  const kitDir = options.setupOnly === true ? null : resolveKitDir(options.kitDir);

  const connection = { baseUrl: options.baseUrl, project };
  const baseUrl = resolveVoicelabBaseUrl(connection);
  /* First run on a fresh environment: the default slug is a project that
   * does not exist yet, and a bare `talk` provisions its own home. */
  await ensureProjectExists(connection);
  using itx = await connectProject(connection);

  /* Declare the guest BEFORE calling into it: `setupVoiceAgent` lives inside
   * @iterate-com/voice-agent, so package.json has to name the package before
   * there is anything to call — a talk command that only ran setup would
   * work on a project somebody had already set up and fail against a fresh
   * one. Present is enough: a spec somebody pinned on purpose stays as it
   * is (`voicelab deploy` is the upgrade path), and a repo that already
   * declares the package is left untouched. */
  /* FROM THIS CHECKOUT, NOT FROM A PUBLISHED PACKAGE. The agent is userspace
   * code and the config repo is its deployment unit, so the checkout's own
   * copy of the facet's source goes into the repo and the platform builds
   * it from there on the next call — no OS deploy, no package publish, no
   * preview pin (which rewrites every published-package spec to the
   * deployed commit; see installVoiceAgentFromSource). An edit to
   * packages/voice-agent is live on the next `talk`. */
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
    voiceAgentEntrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
  const health = await waitForVoiceAgent(voiceAgent);
  console.log(`voice-agent healthy for ${health.projectId}`);

  /*
   * Asked for, not invented. A generated UUID makes every run a conversation
   * nobody can find again; a name you chose is one you can point setup, the
   * agent and a later look at the stream all at.
   */
  const streamPath =
    options.streamPath ??
    (options.auto === true
      ? defaultStreamPath()
      : await promptWithDefault("Stream", defaultStreamPath()));
  if (!streamPath.startsWith("/")) {
    throw new Error(`stream path must be absolute; received ${JSON.stringify(streamPath)}`);
  }
  /*
   * A CHANGED INSTALL MUST REACH THE RUNNING FACET. The facet is a STATEFUL
   * durable worker: it keeps the bundle it booted with for as long as it
   * stays warm, and back-to-back voicelab runs keep it warm indefinitely —
   * measured on prd (2026-08-26 evening): three commits behind while the
   * stateless entrypoint rebuilt every run, so setup wrote the new
   * contract's delivery filter and the live facet installed the previous
   * revision's stale subscription. Killing the incarnation is the
   * upgrade: the next dispatch boots the build this run just committed.
   */
  if (install.changed) {
    /* kill() is the platform's RPC on every stateful dynamic worker handle;
     * the generated capability type carries only the guest's own exported
     * methods, so the platform verb has to be asserted on. */
    using facetWorker = itx.workers.get(voiceAgentFacetRef(streamPath)) as unknown as {
      kill(): Promise<void>;
    } & Disposable;
    /* The abort takes the killing RPC down with the incarnation — "kill
     * requested" IS the success signal, so the rejection is swallowed. */
    await facetWorker.kill().catch(() => {});
    console.log(`restarted voice-agent facet worker for the new build`);
  }
  const setup = await withRpcResult(
    voiceAgent.setupVoiceAgent({
      streamPath,
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
      ...(options.visemes === true && { visemes: true }),
      ...(() => {
        const tools = [
          ...(options.hangUp !== false
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
              }[])),
        ];
        return tools.length > 0 ? { tools } : {};
      })(),
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
  const room = path.join(runDir, "room.wav");
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

  /* The recordings are the evidence of a bad run, so they are linked even
   * when the CLI exits non-zero — that is when they matter most. */
  let exit: unknown;
  try {
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
        // The CLI records the room itself, after its audio units are up (see
        // cli_main_start_room_recorder); it only has a speaker to hear when live.
        ...(options.pretendSpeaker === undefined ? ["--room-wav", room] : []),
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
  } catch (error) {
    exit = error;
  }

  if (fs.existsSync(reportJson)) reportSpeakerContinuity(reportJson);
  reportRecordings(runDir, micRecord, playback, room);
  if (exit !== undefined) throw exit;
}

/**
 * The run's audio, as links. Three witnesses, each on its own clock:
 *
 * - microphone: what the model heard — the echo-cancelled capture.
 * - speaker: what CoreAudio was handed, byte for byte on its own clock,
 *   silence and holes included (the render tap in darwin_audio_output.c).
 *   A hole in playback is a hole in this file; the playout's own record
 *   could never show one, because concealment plays nothing.
 * - room: what a person in the room heard — the default input recorded by
 *   sox, a child the CLI starts once its audio units are up (a recorder
 *   started earlier sees the device change rate under it), so the speaker
 *   is in it along with the person. This is the independent recording: downstream
 *   of everything, CoreAudio and the voice-processing unit included.
 *
 * Then the microphone and the speaker overlaid (mic left, speaker right, so
 * a hole in the answer sits next to what the room was doing) and a mono mix.
 * sox does the mixing when installed; without it the raw files are still
 * linked. All three start within a moment of the audio units' start.
 */
function reportRecordings(runDir: string, micRecord: string, playback: string, room: string): void {
  const link = (file: string) => `file://${file}`;
  const durationSeconds = (file: string): string => {
    if (!fs.existsSync(file)) return "missing";
    const header = Buffer.alloc(44);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, header, 0, 44, 0);
    } finally {
      fs.closeSync(fd);
    }
    /* Canonical 44-byte PCM WAV header: byte rate at 28, data size at 40. */
    const byteRate = header.readUInt32LE(28);
    const dataBytes = fs.statSync(file).size - 44;
    return byteRate > 0 ? (dataBytes / byteRate).toFixed(1) : "?";
  };
  console.log(`\n  RECORDINGS`);
  console.log(
    `    microphone   ${link(micRecord)}  (${durationSeconds(micRecord)} s, echo-cancelled: what the model heard)`,
  );
  console.log(
    `    speaker      ${link(playback)}  (${durationSeconds(playback)} s, what CoreAudio was handed, holes included)`,
  );
  if (fs.existsSync(room)) {
    console.log(
      `    room         ${link(room)}  (${durationSeconds(room)} s, recorded by sox: what a person heard)`,
    );
  }
  if (!fs.existsSync(micRecord) || !fs.existsSync(playback)) return;
  const sox = spawnSync("sox", ["--version"], { stdio: "ignore" });
  if (sox.status !== 0) {
    console.log(`    (install sox for the overlaid and mixed versions)`);
    return;
  }
  const overlay = path.join(runDir, "overlay-mic-left-speaker-right.wav");
  const mix = path.join(runDir, "mix.wav");
  /* -M merges channels (mic → left, speaker → right); -m sums them. Both
   * pad the shorter input with silence to the longer one's length. */
  const merged = spawnSync("sox", ["-M", micRecord, playback, overlay], { stdio: "ignore" });
  const mixed = spawnSync("sox", ["-m", micRecord, playback, mix], { stdio: "ignore" });
  if (merged.status === 0)
    console.log(`    overlaid     ${link(overlay)}  (mic left, speaker right)`);
  if (mixed.status === 0) console.log(`    mixed        ${link(mix)}`);
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
 * Make sure the project can reach OpenAI, using the key from the
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
 * matches; silently rotating the OpenAI key of a running project because
 * somebody ran a voice command would be a genuinely bad surprise.
 */
export async function ensureOpenaiSecret(itx: unknown): Promise<string> {
  return await ensureOpenaiProjectSecret(itx, {
    path: "/secrets/openai",
    envNames: ["OPENAI_API_KEY", "APP_CONFIG_OPENAI_API_KEY"],
    egress: ["https://api.openai.com"],
  });
}

/** The subset of the secret capability this command uses. */
interface OpenaiProjectSecret {
  __describe(): Promise<{ created?: boolean; hasMaterial?: boolean }>;
  create(input: { egress: { urls: string[] }; material: string }): Promise<unknown>;
  update(input: { material: string }): Promise<unknown>;
}

async function ensureOpenaiProjectSecret(
  itx: unknown,
  args: { path: string; envNames: string[]; egress: string[] },
): Promise<string> {
  /* The project handle arrives untyped (the generated client type lives in
   * apps/os); the assertion spells exactly the one member this command uses,
   * so a wrong assertion fails loudly at the RPC boundary. */
  const secret = (itx as { secrets: { get(path: string): OpenaiProjectSecret } }).secrets.get(
    args.path,
  );
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
  /** Attended open mic: the C streams continuously and GPT-Live hears the
   * room. Off, holding SPACE unmutes the microphone — a fact about this
   * driver only; the stream sees frames while it is held and nothing else. */
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
  return args;
}

/** This checkout's copy of the facet's source, keyed as the installer wants it. */
function readVoiceAgentSource(): Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const src = path.resolve(here, "../../../../packages/voice-agent/src");
  return Object.fromEntries(
    VOICE_AGENT_SOURCE_FILES.map((file) => [file, fs.readFileSync(path.join(src, file), "utf8")]),
  ) as Record<(typeof VOICE_AGENT_SOURCE_FILES)[number], string>;
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
