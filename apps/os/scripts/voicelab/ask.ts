// Ask a deployed voice agent to DO things, from the wire, and report what its
// backend did and what the voice said.
//
//   doppler run --config prd -- pnpm cli voicelab ask --project <slug> --setup \
//     --requests '["Create a file called notes/hello.md in my repo saying hello world, and commit it.",
//                  "Now read it back to me."]' \
//     --verify 'return await itx.repo.readFile({ path: "notes/hello.md" })'
//
// THE TASK BATTERY. The itx example catalogue and the e2e matrix say what a
// project can do through scripts — commit files, edit them, run a workspace,
// schedule a job, message an agent, run a sandbox. This command speaks those
// tasks to the voice one at a time and reads the whole exchange back off the
// stream: the delegation, every backend function call with its arguments and
// the facet's answer, the backend's final text, the voice's words. `--verify`
// then runs an itx script body against the project so the CLAIMED effect is
// checked against the project's actual state. Judgement stays with the
// reader; this prints evidence.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { sleep, synthesizeFrames } from "./probe-audio.ts";
import { talk } from "./talk.ts";
import { openWireCall } from "./wire-call.ts";

/** Options for `pnpm cli voicelab ask`. */
export interface AskOptions extends VoicelabConnectOptions {
  /** The stream whose agent is asked. A fresh timestamped path when omitted. */
  streamPath?: string;
  /** Install the agent on the stream first (talk --setup-only --open-mic). */
  setup?: boolean;
  /** With --setup: the backend model (gpt-6-astra by default). */
  backendModel?: string;
  /** With --setup: reasoning effort for the backend. */
  backendEffort?: string;
  /** The spoken requests, in order, as a JSON array of strings. */
  requests: string;
  /** How long to give each request's backend work before moving on. */
  requestTimeoutMs?: number;
  /** Silence after the voice's last word that ends a request. */
  settleMs?: number;
  /** An itx script BODY (with `itx` in scope, ending in `return …`) run after
   * the last request, against the project, to check the effect. */
  verify?: string;
}

/* The CLI runtime's own wrapping (scripts/itx.ts): the body becomes an async
 * function body with `itx` in scope. The constructor of an async function IS
 * the AsyncFunction constructor, which TypeScript types only as `Function`;
 * the assertion restates what it builds. */
const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown) => Promise<unknown>;

export async function ask(options: AskOptions): Promise<void> {
  const requests = JSON.parse(options.requests) as unknown;
  if (!Array.isArray(requests) || requests.some((request) => typeof request !== "string")) {
    throw new Error("--requests must be a JSON array of strings");
  }
  const spoken = requests as string[];
  /* A fresh stream per run: two runs a minute apart must never share one
   * (a shared stream's call is already live, and its session.started went
   * by before this run's listener was attached). */
  const streamPath =
    options.streamPath ??
    `/agents/voice/ask-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const requestTimeoutMs = options.requestTimeoutMs ?? 150_000;
  const settleMs = options.settleMs ?? 4_000;

  if (options.setup === true) {
    await talk({
      project: options.project,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      streamPath,
      setupOnly: true,
      auto: true,
      openMic: true,
      ...(options.backendModel === undefined
        ? {}
        : {
            backendModel: options.backendModel,
            backendEffort: options.backendEffort ?? "low",
            backendServiceTier: "priority",
          }),
    });
  }

  const dir = mkdtempSync(path.join(tmpdir(), "ask-"));
  const utterances = spoken.map((text, index) => synthesizeFrames(dir, `request-${index}`, text));
  rmSync(dir, { recursive: true, force: true });

  const call = await openWireCall({ ...options, streamPath });
  const { watch } = call;
  console.log(`  open mic on ${streamPath}; waiting for the session…`);
  await sleep(1_500);
  const live = await call.waitFor(
    () => call.micFramesSent() > 0 && watch.providerEventCounts["session.started"] !== undefined,
    45_000,
  );
  if (!live) {
    console.log("  FAIL: the session never started");
    process.exitCode = 1;
    await call.stop();
    return;
  }

  const results: {
    request: string;
    delegated: boolean;
    functionCalls: string[];
    said: string;
    tookMs: number;
  }[] = [];
  for (const [index, frames] of utterances.entries()) {
    const request = spoken[index]!;
    const before = {
      delegations: watch.delegations.length,
      calls: watch.backendCalls.length,
      answers: watch.answersEnded,
      transcript: watch.outputTranscript.length,
      input: watch.inputTranscript.length,
      progressNotes: watch.providerEventCounts["client.session.thinking.append"] ?? 0,
    };
    console.log(`\n  ▶ "${request}"`);
    const startedAt = call.clock();
    await call.speak(frames);
    /* A request is over when the voice has answered at least once after it,
     * every delegation it raised has the backend's FINAL text (a function
     * round's end is not the end), and the voice has then gone quiet. A
     * delegation raised late still counts: the voice often acknowledges
     * first and delegates a moment later. Bounded by the timeout. */
    const settled = await call.waitFor(() => {
      const raised = watch.delegations.slice(before.delegations);
      return (
        watch.answersEnded > before.answers &&
        raised.every((delegation) => delegation.finalTextDoneAtMs !== null) &&
        call.quietFor(settleMs) &&
        call.clock() - startedAt > settleMs + 6_000
      );
    }, requestTimeoutMs);
    const functionCalls = watch.backendCalls.slice(before.calls);
    const heard = watch.inputTranscript.slice(before.input).trim();
    console.log(`    heard: ${heard.slice(0, 400)}`);
    for (const delegation of watch.delegations.slice(before.delegations)) {
      const carried = delegation.inputTranscriptAtCreation.slice(before.input).trim();
      console.log(
        `    delegation ${delegation.id} at +${String(delegation.createdAtMs - startedAt)}ms carried ` +
          `${String(carried.length)}/${String(heard.length)} chars of the request: "${carried.slice(-160)}"`,
      );
      if (delegation.finalText !== "")
        console.log(`    backend: ${delegation.finalText.slice(0, 400)}`);
    }
    const said = watch.outputTranscript.slice(before.transcript).trim();
    const delegated = watch.delegations.length > before.delegations;
    results.push({ request, delegated, functionCalls, said, tookMs: call.clock() - startedAt });
    const progressNotes =
      (watch.providerEventCounts["client.session.thinking.append"] ?? 0) - before.progressNotes;
    console.log(
      `    delegated: ${String(delegated)}; progress notes to the voice: ${String(progressNotes)}${settled ? "" : "  (timed out waiting)"}`,
    );
    for (const line of functionCalls) console.log(`    ${line}`);
    console.log(`    said: ${said.slice(0, 600)}`);
  }

  await call.stop();
  await sleep(2_000);
  const durable = await call.durableEvents();
  const replies = durable.filter((event) => event.type.endsWith("/backend-reply"));
  for (const reply of replies) {
    /* backend-reply's payload is `{ text }` by the agent's contract. */
    console.log(
      `\n  backend reply: ${String((reply.payload as { text?: string }).text ?? "").slice(0, 500)}`,
    );
  }

  if (options.verify !== undefined) {
    using itx = await connectProject(options);
    const script = new AsyncFunction("itx", options.verify);
    try {
      const result = await script(itx);
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
        delegated: result.delegated,
        functionCalls: result.functionCalls.filter((line) => line.startsWith("→")).length,
        tookMs: result.tookMs,
      })),
    )}`,
  );
}
