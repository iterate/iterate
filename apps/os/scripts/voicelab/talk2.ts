// Talk to the SECOND voice agent, the clean rewrite, on a real deployment.
//
//   doppler run --config preview_3 -- pnpm cli voicelab talk2 --project voice-test
//
// THE POINT OF THIS FILE IS THAT IT IS A SECOND ONE.
//
// `talk.ts` drives `voice-agent.ts`; this drives `voice-agent2.ts`; both live
// in the same project's config repo at the same time, on different streams,
// and neither redeploys the other. A comparison between two agents is only
// worth having if switching between them is not itself a variable — the moment
// running v2 means overwriting v1, every "v2 is better" is confounded by
// whatever else changed in the redeploy.
//
// WHAT IS DELIBERATELY SHARED. The host CLI binary, the run directory layout,
// the microphone, the speaker, the utterance corpus and the report format all
// come from `talk.ts` by import rather than by copy. Those are the INSTRUMENT,
// and an instrument that differs between the two measurements measures the
// instrument. The C binary understands both dialects of `spk-frame` for the
// same reason.
//
// WHAT IS DIFFERENT, AND IT IS ONLY THREE THINGS: which entry point gets
// committed, which setup method is called, and — the reason this exercise
// exists — that v2 numbers every speaker frame within a conversation, so the
// report can say whether a long call lost any of them. See --report at the
// bottom: that is the proof, and it is arithmetic rather than opinion.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { connectProject, resolveVoicelabBaseUrl } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import { withRpcResult } from "./rpc-ownership.ts";
import {
  buildHostCli,
  driverArgs,
  ensureXaiSecret,
  promptWithDefault,
  resolveKitDir,
  runInherited,
  voicelabRunsDir,
  ensureOpenaiSecret,
  type TalkOptions,
} from "./talk.ts";
import { voiceAgent2EntrypointRef } from "./voice-agent2-ref.ts";
import type VoiceAgent2Entrypoint from "./config-repo/voice-agent2.ts";

const DEFAULT_PROJECT = "voice-test";
const DEFAULT_MINUTES = 30;
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_RETRY_MS = 1_000;

/**
 * What to tell the model it is, when the caller does not say.
 *
 * v2 has no tools and therefore nothing to derive a prompt from, so unlike the
 * first track this is a plain string rather than a description of the
 * project's live capabilities. Counting is in here on purpose: a monotonic
 * sequence spoken aloud is the one answer whose gaps a human ear can hear, so
 * it is the utterance every audio bug in this lab has been caught with.
 */
const DEFAULT_INSTRUCTIONS =
  "You are Iterate, a voice assistant on a small speaker. Keep replies short and " +
  "natural. When asked to count, count steadily and do not stop early.";

/**
 * The RPC contract exported by voice-agent2.ts, which no generated client can
 * carry — picked off the REAL entrypoint class rather than hand-mirrored, so
 * there are zero fields to drift, ever. The import is `type`-only, which is
 * what lets it cross the worker/node boundary: type imports are erased by tsx
 * before any resolution (proven both ways), where a VALUE import from
 * config-repo dies at load with ERR_UNSUPPORTED_ESM_URL_SCHEME (F4).
 */
type VoiceAgent2Setup = Pick<VoiceAgent2Entrypoint, "health" | "setupVoiceAgent2">;

/** Options for `pnpm cli voicelab talk2`. Same surface as `talk`, plus v2's own. */
export interface Talk2Options extends TalkOptions {
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
}

export async function talk2(options: Talk2Options = {}) {
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

  /* Install the guest BEFORE calling into it: `setupVoiceAgent2` lives inside
   * voice-agent2.ts, so the file has to be in the repo before there is
   * anything to call. `entryName` is what keeps this from landing on top of
   * the first track — the repo is flat and both entry points sit in it. */
  const install = await installVoiceAgent(itx, { entryName: "voice-agent2.ts" });
  console.log(
    install.changed
      ? `installed voice-agent2.ts (${install.commitOid.slice(0, 8)})`
      : `voice-agent2.ts already current (${install.commitOid.slice(0, 8)})`,
  );

  /* Only the secret the chosen provider's dial will spend — setup's gate is
   * per-provider now (secretForHost), and a baseUrl seam needs none at all. */
  if (options.providerBaseUrl === undefined) {
    console.log(
      options.provider === "openai"
        ? `openai secret ${await ensureOpenaiSecret(itx)}`
        : `xai secret ${await ensureXaiSecret(itx)}`,
    );
  }

  using voiceAgent = itx.workers.get(
    voiceAgent2EntrypointRef,
  ) as unknown as DynamicWorkerCapability<VoiceAgent2Setup>;
  const health = await waitForVoiceAgent2(voiceAgent);
  console.log(`voice-agent2 healthy for ${health.projectId}`);

  /*
   * A DIFFERENT DEFAULT PATH FROM THE FIRST TRACK, and it matters.
   *
   * Both agents share the contract slug `voice-agent`, because the slug is the
   * subscription's name and the boards already speak these event names. Two
   * subscriptions of one name cannot both live on one stream — the second
   * REPLACES the first. So the two tracks are kept apart by stream instead,
   * and defaulting v2 to /agents/voice2/* means an absent-minded `talk2` on
   * yesterday's v1 stream cannot silently evict the agent you were comparing
   * against.
   */
  const streamPath =
    options.streamPath ?? (await promptWithDefault("Stream", defaultStream2Path()));
  if (!streamPath.startsWith("/")) {
    throw new Error(`stream path must be absolute; received ${JSON.stringify(streamPath)}`);
  }
  const setup = await withRpcResult(
    voiceAgent.setupVoiceAgent2({
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
      ...(options.turnDetection !== undefined && {
        turnDetection: JSON.parse(options.turnDetection) as Record<string, unknown> & {
          type: string;
        },
      }),
      ...(options.hangUp === true && {
        tools: [
          {
            name: "hang_up",
            description:
              "End this call when the user says goodbye or the conversation is clearly " +
              "over. Say a short goodbye BEFORE calling this; the call ends after you " +
              "finish speaking.",
          },
        ],
      }),
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
  const runDir = path.join(voicelabRunsDir(), `${stamp}-v2-${path.basename(setup.streamPath)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const playback = path.join(runDir, "speaker.wav");
  const micRecord = path.join(runDir, "mic.wav");
  const reportJson = path.join(runDir, "report.json");

  console.log(`\n  ${baseUrl} · ${project} · voice-agent2`);
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
      /* NO HYPHEN: the name becomes the capability mount and a hyphen there is
       * rejected about five seconds in, with a message that says nothing about
       * names. */
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
 * to what actually arrived is the device that received them, which is why v2
 * numbers every frame within a conversation and why the host CLI counts the
 * gaps: a missing sequence number is a lost frame, and there is no other way
 * to distinguish "the answer was short" from "the answer was cut".
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
async function waitForVoiceAgent2(
  voiceAgent: DynamicWorkerCapability<VoiceAgent2Setup>,
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

/** A fresh v2 conversation, named for when it happened. */
function defaultStream2Path(): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 12);
  return `/agents/voice2/${stamp}`;
}
