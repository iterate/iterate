// Ask a deployed GPT-Live voice agent to perform work and record the durable
// user utterance, spoken answer, backend reply, and optional state check.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { sleep, synthesizeFrames } from "./probe-audio.ts";
import { talk } from "./talk.ts";
import { openWireCall } from "./wire-call.ts";

export interface AskOptions extends VoicelabConnectOptions {
  streamPath?: string;
  setup?: boolean;
  requests: string;
  requestTimeoutMs?: number;
  settleMs?: number;
  verify?: string;
  micOffBetweenRequests?: boolean;
}

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown) => Promise<unknown>;

export async function ask(options: AskOptions): Promise<void> {
  const parsed: unknown = JSON.parse(options.requests);
  if (!Array.isArray(parsed) || parsed.some((request) => typeof request !== "string")) {
    throw new Error("--requests must be a JSON array of strings");
  }
  const requests = parsed as string[];
  const streamPath =
    options.streamPath ||
    `/agents/voice/ask-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const requestTimeoutMs = options.requestTimeoutMs ?? 150_000;
  const settleMs = options.settleMs ?? 4_000;

  if (options.setup === true) {
    await talk({
      project: options.project,
      baseUrl: options.baseUrl,
      streamPath,
      setupOnly: true,
      auto: true,
      openMic: true,
    });
  }

  const directory = mkdtempSync(path.join(tmpdir(), "ask-"));
  const utterances = requests.map((text, index) =>
    synthesizeFrames(directory, `request-${index}`, text),
  );
  rmSync(directory, { recursive: true, force: true });

  const call = await openWireCall({
    ...options,
    streamPath,
    ...(options.micOffBetweenRequests === true && { micOffBetweenUtterances: true }),
  });
  const { watch } = call;
  console.log(`  open mic on ${streamPath}; waiting for GPT-Live…`);
  const live = await call.waitFor(
    () => watch.conversationAcceptedAtMs !== null && watch.sessionConfiguredAtMs !== null,
    45_000,
  );
  if (!live) {
    console.log("  FAIL: the GPT-Live session never became ready");
    process.exitCode = 1;
    await call.stop("session-not-ready");
    return;
  }

  const results: { request: string; said: string; backendReply: string; tookMs: number }[] = [];
  for (const [index, frames] of utterances.entries()) {
    const request = requests[index]!;
    const before = {
      answers: watch.answers.length,
      answerEnds: watch.answersEnded,
      backendReplies: watch.backendReplies.length,
      utterances: watch.utterances.length,
      errors: watch.providerErrors.length,
      disconnects: watch.providerDisconnects.length,
    };
    const startedAt = call.clock();
    console.log(`\n  ▶ "${request}"`);
    await call.speak(frames);
    const settled = await call.waitFor(
      () =>
        watch.answersEnded > before.answerEnds &&
        call.quietFor(settleMs) &&
        call.clock() - startedAt > settleMs,
      requestTimeoutMs,
    );
    const heard = watch.utterances
      .slice(before.utterances)
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const said = watch.answers
      .slice(before.answers)
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const backendReply = watch.backendReplies
      .slice(before.backendReplies)
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const framesThisRequest = watch.spkArrivals.filter((arrival) => arrival.atMs >= startedAt);
    const audioMs = framesThisRequest.reduce((total, arrival) => total + arrival.payloadMs, 0);
    console.log(`    heard: ${heard.slice(0, 400)}`);
    console.log(
      `    speaker: ${String(framesThisRequest.length)} frames, ${String(Math.round(audioMs))} ms`,
    );
    console.log(`    said: ${said.slice(0, 600)}`);
    if (backendReply !== "") console.log(`    backend: ${backendReply.slice(0, 600)}`);
    for (const error of watch.providerErrors.slice(before.errors))
      console.log(`    provider error: ${error.text.slice(0, 300)}`);
    for (const disconnect of watch.providerDisconnects.slice(before.disconnects))
      console.log(`    provider disconnected: ${disconnect.text.slice(0, 300)}`);
    if (!settled) console.log("    timed out waiting for the answer to settle");
    results.push({ request, said, backendReply, tookMs: call.clock() - startedAt });
  }

  await call.stop();
  await sleep(2_000);

  if (options.verify) {
    using itx = await connectProject(options);
    try {
      const result = await new AsyncFunction("itx", options.verify)(itx);
      console.log(`\n  verify → ${JSON.stringify(result, null, 2).slice(0, 1_500)}`);
    } catch (error) {
      console.log(`\n  verify FAILED → ${String(error).slice(0, 500)}`);
      process.exitCode = 1;
    }
  }

  console.log(
    `\n  summary ${JSON.stringify(
      results.map((result) => ({
        request: result.request.slice(0, 60),
        backendReply: result.backendReply !== "",
        tookMs: result.tookMs,
      })),
    )}`,
  );
}
