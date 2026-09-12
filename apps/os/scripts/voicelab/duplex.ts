// Prove one GPT-Live call from the wire: ready session, continuous mic,
// speaker output, interruption, durable transcripts, and Agent commentary.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { type VoicelabConnectOptions } from "./connect.ts";
import { gapStatsOfGaps } from "./live-probe.ts";
import { sleep, synthesizeFrames } from "./probe-audio.ts";
import { talk } from "./talk.ts";
import { openWireCall } from "./wire-call.ts";

export interface DuplexOptions extends VoicelabConnectOptions {
  streamPath?: string;
  setup?: boolean;
  bargeAfterMs?: number;
  skipDelegation?: boolean;
  delegationTimeoutMs?: number;
  micBatchFrames?: number;
  micEventFrames?: number;
  noiseEventsPerAppend?: number;
  keepaliveEventsPerAppend?: number;
}

export async function duplex(options: DuplexOptions): Promise<void> {
  const streamPath =
    options.streamPath ||
    `/agents/voice/duplex-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const bargeAfterMs = options.bargeAfterMs ?? 4_000;
  const delegationTimeoutMs = options.delegationTimeoutMs ?? 150_000;
  if (options.setup === true) {
    await talk({
      project: options.project,
      baseUrl: options.baseUrl,
      streamPath,
      setupOnly: true,
      auto: true,
    });
  }

  const directory = mkdtempSync(path.join(tmpdir(), "duplex-"));
  const request = synthesizeFrames(
    directory,
    "request",
    "Please count slowly from one to fifty, one number at a time, and do not stop early.",
  );
  const interjection = synthesizeFrames(
    directory,
    "interjection",
    "Stop counting please. Tell me the last number you said out loud.",
  );
  const delegatedRequest = synthesizeFrames(
    directory,
    "delegation",
    "Can you check what files are in my project's config repo, and tell me how many there are?",
  );
  rmSync(directory, { recursive: true, force: true });

  const call = await openWireCall({ ...options, streamPath });
  const { watch } = call;
  const verdict: Record<string, boolean | null> = {};
  const fail = (message: string) => {
    console.log(`  FAIL: ${message}`);
    process.exitCode = 1;
  };

  console.log(`  continuous mic on ${streamPath}; waiting for GPT-Live…`);
  const started = await call.waitFor(
    () => watch.conversationAcceptedAtMs !== null && watch.sessionConfiguredAtMs !== null,
    30_000,
  );
  if (!started) fail("the GPT-Live call never became ready");
  verdict.session = started;

  const idleStart = watch.spkFrames;
  await sleep(3_000);
  const idleSpeakerFrames = watch.spkFrames - idleStart;
  verdict.idleDownlink = idleSpeakerFrames === 0;
  if (!verdict.idleDownlink) fail(`${String(idleSpeakerFrames)} speaker frames arrived while idle`);

  console.log(`  speaking the count request (${String(request.length)} frames)…`);
  void call.speak(request);
  const counting = await call.waitFor(() => watch.answerDeliveredMs >= bargeAfterMs, 60_000);
  if (!counting)
    fail(`only ${String(Math.round(watch.answerDeliveredMs))}ms of answer arrived in 60s`);
  const answersBeforeBarge = watch.answersEnded;
  const clearsBeforeBarge = watch.clearsSeen;
  const bargeAtMs = call.clock();
  console.log(
    `  interrupting at ${String(Math.round(watch.answerDeliveredMs))}ms of delivered audio…`,
  );
  void call.speak(interjection);
  const stopped = await call.waitFor(
    () => call.quietFor(700) && call.clock() > bargeAtMs + 700,
    20_000,
  );
  const stoppedAfterBargeMs =
    stopped && watch.lastAudioFrameAtMs !== null
      ? Math.max(0, watch.lastAudioFrameAtMs - bargeAtMs)
      : null;
  const replied = await call.waitFor(() => watch.answersEnded >= answersBeforeBarge + 2, 30_000);
  verdict.barge = stoppedAfterBargeMs !== null && stoppedAfterBargeMs < 2_500 && replied;
  verdict.noClearNeeded = watch.clearsSeen === clearsBeforeBarge;
  if (!verdict.barge)
    fail(
      `barge stopped ${String(stoppedAfterBargeMs)}ms after speech; answers ended ${String(watch.answersEnded)}`,
    );

  let commentaryAtMs: number | null = null;
  if (options.skipDelegation !== true) {
    await call.waitFor(() => call.quietFor(1_500), 15_000);
    const commentaryBefore = watch.commentary.length;
    const answersBefore = watch.answersEnded;
    const askedAtMs = call.clock();
    console.log("  asking for backend work…");
    void call.speak(delegatedRequest);
    const receivedCommentary = await call.waitFor(
      () => watch.commentary.length > commentaryBefore,
      delegationTimeoutMs,
    );
    if (receivedCommentary) commentaryAtMs = watch.commentary.at(-1)!.atMs - askedAtMs;
    const spoken = await call.waitFor(() => {
      const commentary = watch.commentary.at(-1);
      if (!commentary) return false;
      return (
        watch.answers.some((answer) => answer.atMs >= commentary.atMs) &&
        watch.answersEnded > answersBefore &&
        call.quietFor(1_500)
      );
    }, delegationTimeoutMs);
    verdict.delegation = receivedCommentary && spoken;
    if (!verdict.delegation) fail("Agent commentary was not durably recorded and spoken");
  }

  await call.stop();
  await sleep(2_500);
  const durable = await call.durableEvents();
  const utterances = durable.filter((event) => event.type.endsWith("/utterance-transcript"));
  const answers = durable.filter((event) => event.type.endsWith("/answer-transcript"));
  verdict.transcript = utterances.length >= 2 && answers.length >= 2;
  verdict.duplex = call.micFramesSent() > 0;
  if (!verdict.transcript)
    fail(`transcript: ${String(utterances.length)} utterances, ${String(answers.length)} answers`);

  const gaps: number[] = [];
  for (let index = 1; index < watch.spkArrivals.length; index++) {
    const previous = watch.spkArrivals[index - 1]!;
    const current = watch.spkArrivals[index]!;
    if (previous.answerIndex === current.answerIndex) gaps.push(current.atMs - previous.atMs);
  }
  const arrivalGaps = gapStatsOfGaps(gaps);
  const appendLatencies = [...watch.micAppendLatenciesMs].sort((a, b) => a - b);
  const at = (q: number) =>
    appendLatencies[Math.min(appendLatencies.length - 1, Math.floor(q * appendLatencies.length))] ??
    0;

  console.log("\n  FULL DUPLEX THROUGH THE PLATFORM (GPT-Live)");
  console.log(`    activation                 ${watch.activation}`);
  console.log(
    `    handshake                  ${String(watch.handshakeTookMs ?? "?")}ms; held ${String(watch.heldMicFrames ?? "?")} mic frames`,
  );
  console.log(`    mic frames sent            ${String(call.micFramesSent())}`);
  console.log(`    idle speaker frames        ${String(idleSpeakerFrames)} in 3s`);
  console.log(`    answer audio delivered     ${String(Math.round(watch.answerDeliveredMs))}ms`);
  console.log(`    barge stop                 ${String(stoppedAfterBargeMs)}ms`);
  console.log(
    `    Agent commentary           ${commentaryAtMs === null ? "not tested" : `${String(commentaryAtMs)}ms`}`,
  );
  console.log(
    `    provider diagnostics       ${String(watch.providerErrors.length)} errors, ${String(watch.providerDisconnects.length)} disconnects`,
  );
  console.log(
    `    durable transcript         ${String(utterances.length)} utterances, ${String(answers.length)} answers`,
  );
  console.log(
    `    mic append p50/p90/p99     ${String(at(0.5))}/${String(at(0.9))}/${String(at(0.99))}ms`,
  );
  console.log(
    `    speaker frame gaps         p50 ${String(arrivalGaps.p50)} p90 ${String(arrivalGaps.p90)} p99 ${String(arrivalGaps.p99)} max ${String(arrivalGaps.max)}ms`,
  );
  console.log(
    `\n  heard: ${watch.utterances
      .map((entry) => entry.text)
      .join(" ")
      .slice(0, 400)}`,
  );
  console.log(
    `  said:  ${watch.answers
      .map((entry) => entry.text)
      .join(" ")
      .slice(0, 600)}`,
  );
  for (const commentary of watch.commentary)
    console.log(`  outcome: ${commentary.text.slice(0, 300)}`);
  for (const diagnostic of [...watch.providerErrors, ...watch.providerDisconnects])
    console.log(`  provider: ${diagnostic.text.slice(0, 300)}`);
  console.log(`\n  verdict ${JSON.stringify(verdict)}`);
}
