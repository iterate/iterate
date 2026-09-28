// The voice package as this checkout has it, mounted exactly as the installer mounts it, on a call
// whose agent is the agents app's. Only the provider URL is replaced: a real deployed WebSocket
// fixture speaks the small GPT-Live protocol below. It delegates when it hears a question frame,
// and speaks back (transcribes as its own speech) every commentary the relay sends it. The agent's
// model is a fake `itx.ai` lent to the call's context, except in the REAL row.
// This pins loaded-code admission, agent birth, inherited KV/egress, secret substitution, the
// hand-over to the agent, its sandbox scripts, its answer reaching the live model, and audio in both
// directions. It does not test the live model, microphones or speakers.
import { expect } from "vitest";
import { installAgents } from "@iterate-com/agents/install";
import { installVoice } from "@iterate-com/voice/install";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../../../packages/agents/src/system-prompt.ts";
import { openItx, readAll, runId, until, untilValue } from "../../os/e2e/support/client.ts";
import { FakeAi, sseResponse } from "../../os/e2e/support/fake-ai.ts";
import { oauthSession } from "../../os/e2e/support/principal.ts";
import { publishConfigWorker } from "../../os/e2e/support/config-worker.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  projectUrl,
  realModelOnly,
  registerProject,
} from "../../os/e2e/support/project-host.ts";
import { agentsWorkspaceSource } from "./agents-source.ts";
import { voiceWorkspaceSource } from "./support.ts";

const CLOCK = "What time is it in London?";
const WEBSITE = "Add a horse joke to the website and verify it is live.";
const TWO_PLUS_TWO = "What is two plus two?";

deployedOnly(
  "a delegated question reaches the call's agent as the person's words, and its answer is what the live model speaks",
  async () => {
    const candidateSource =
      'export default {fetch() { return new Response("Because it had bad stable manners!"); }};';
    // Execute the exact candidate-probe example taught to the agent. A stale module
    // name in that prompt consumed a recovery step in the real Satellite call.
    const candidateProbe = DEFAULT_AGENT_SYSTEM_PROMPT.match(
      /`(await itx\.workers\.get\(\{ source: .*?candidateSource.*?\}\)\.fetch\(new Request\(projectUrl\)\))`/,
    )?.[1];
    expect(candidateProbe).toBeTruthy();
    const call = await voiceCall(({ websiteUrl }) => {
      const websiteScripts = [
        "return await itx.whoami();",
        'return await itx.repos.get("/repos/config").listFiles();',
        'return await itx.repos.get("/repos/config").readFile("worker.ts");',
        `const candidateSource = ${JSON.stringify(candidateSource)}; const projectUrl = ${JSON.stringify(websiteUrl)}; const response = ${candidateProbe}; const body = await response.text(); if (response.status !== 200 || !body.includes("bad stable manners")) throw new Error("candidate failed"); return body;`,
        `return await itx.repos.get("/repos/config").writeFile("worker.ts", ${JSON.stringify(candidateSource)});`,
        'return await itx.repos.get("/repos/config").readFile("worker.ts");',
        `const response = await itx.fetch(new Request(${JSON.stringify(websiteUrl)})); return {status: response.status, body: await response.text()};`,
      ];
      // The agent's model, played: it answers the newest hand-over from the script results after
      // it, one script a turn, with prose beside the first script that must never be spoken.
      return new FakeAi([
        ({ inputs }) => {
          const input = inputs.input as { role: string; content: string }[];
          const asked = input.findLastIndex((message) => message.role === "user");
          const request = input[asked]!.content;
          const results = input
            .slice(asked + 1)
            .filter((message) => /^Your script (returned|failed)/.test(message.content));
          const failed = results.find((result) => result.content.startsWith("Your script failed"));
          const returned = (index: number) =>
            JSON.parse(results[index]!.content.replace(/^[^`]*```json\n|\n```$/g, ""));
          if (failed) return answer(`A script failed: ${failed.content.slice(0, 400)}`);
          if (request.endsWith(`Person: ${CLOCK}`)) {
            if (results.length === 0)
              return answer(
                '<codemode status="Checking the clock">\nreturn {time: new Date().toISOString(), identity: await itx.whoami()};\n</codemode>\n\nI could not verify the time.',
              );
            const { time, identity } = returned(0);
            return answer(`The sandbox at ${identity.path} read the clock at ${time}.`);
          }
          // The hand-over also carries what the voice said since the last one: the clock answer.
          if (request.endsWith(`Person: ${WEBSITE}`)) {
            if (results.length < websiteScripts.length)
              return answer(
                `<codemode status="Updating the website">\n${websiteScripts[results.length]}\n</codemode>`,
              );
            const published = returned(results.length - 1);
            return answer(
              published.status === 200 && published.body.includes("bad stable manners")
                ? "The horse joke is live on your website."
                : "The website did not publish the joke.",
            );
          }
          return answer(`Unexpected request: ${request}`);
        },
      ]);
    });
    const { received, ai } = call;
    try {
      // The agent's model must execute a script in the conversation's real sandbox: audio alone
      // does not prove the sandbox's redirect is admitted for the call's loaded code.
      const clockStarted = Date.now();
      const clock = await call.ask(CLOCK);
      const [, path, time] = /^The sandbox at (\S+) read the clock at (\S+)\.$/.exec(clock) ?? [];
      expect({ path, spoken: call.spoken() }).toMatchObject({
        path: `${call.streamPath}/sandbox`,
        // Only the final answer is spoken: the prose beside the script is not.
        spoken: [clock],
      });
      expect(Date.parse(time!)).toBeGreaterThanOrEqual(clockStarted);
      expect(Date.parse(time!)).toBeLessThanOrEqual(Date.now());
      // The agent read the call's instructions, the screen guide among them, and none of them
      // started a turn: its first model request answers the first hand-over.
      const firstRequest = ai!.calls[0]!.inputs.input as { role: string; content: string }[];
      expect(firstRequest).toEqual(
        expect.arrayContaining([
          { role: "system", content: expect.stringContaining("# Answering a voice call") },
          { role: "system", content: expect.stringContaining("itx.clients.zectrix_note4") },
        ]),
      );
      // The hand-over came through the call's own `itx.agents`, so it reads as sent from there.
      expect(firstRequest.filter((message) => message.role === "user")).toEqual([
        { role: "user", content: `[from ${call.streamPath}] Person: ${CLOCK}` },
      ]);
      const log = await readAll(call.itx);
      expect(
        log
          .filter((event) => event.type === "events.iterate.com/agent/summary-updated")
          .map((event) => event.payload.activity),
      ).toEqual(["Checking the clock"]);
      const uses = (await readAll(call.root.cd("/secrets/openai"))).filter(
        (event) => event.type === "events.iterate.com/secret/used",
      );
      // The live model's dial is the project's only OpenAI call: the agent's model is its own.
      expect(uses.map((event) => event.payload)).toEqual([
        { method: "GET", url: call.providerUrl, status: 101 },
      ]);
      // The project's creation made and seeded the config repo the scripts below edit; a sandbox
      // creates only beneath itself, so it cannot make that repo.
      await call.root.waitForEvent({
        type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
        afterOffset: 0,
        timeoutMs: 60_000,
      });
      // Seven real sandbox scripts: the candidate probe, the commit, then the live check.
      const websiteAsked = received.length;
      const websiteAskedAt = Date.now();
      await call.say(WEBSITE);
      const isWebsiteAnswer = (event: (typeof received)[number]) =>
        event.type === "events.iterate.com/voice-agent/answer-transcribed" &&
        event.payload.text !== clock;
      // What the agent did so far, a short line an event, each at its time since the request:
      // a wait that runs out names the script it was on, and a wrong answer names what it was given.
      const websiteSteps = (events: typeof received) => {
        const asked = events.slice(websiteAsked);
        const t0 = Date.parse(String(asked[0]?.createdAt));
        return asked
          .filter((event) => !event.type.endsWith("-frame"))
          .map((event) => {
            const { role, content } = event.payload as { role?: string; content?: unknown };
            const said =
              typeof content === "string"
                ? content.replace(/^<codemode[^>]*>\n|^Your script returned:\n/, "")
                : JSON.stringify(event.payload);
            return `+${Date.parse(String(event.createdAt)) - t0}ms ${event.type.replace("events.iterate.com/voice-agent/", "").replace("events.iterate.com/agent/", "")} ${role || ""} ${said.slice(0, 64)}`;
          });
      };
      // THE WAIT IS FOR PROGRESS, a step at a time (docs/testing.md: waits are progress-based): the
      // edit is eight model turns and seven sandbox scripts in a row, each several Durable Object
      // hops, and a hop between two contexts of one project can take 3 s (3.4–8.9 s a step in the
      // slowest runs, Workers traces, 2026-09-24). So 20 s bounds A STEP — an edit that stops still
      // fails 20 s after its last step, naming it — and the whole edit has a backstop of 40 s (the
      // slowest measured edit needed about 30).
      const stepMs = 20_000;
      const wholeMs = 40_000;
      const steps = (events: typeof received) =>
        events
          .slice(websiteAsked)
          .filter((event) => event.type === "events.iterate.com/agent/context-added").length;
      let websiteAnswer: (typeof received)[number] | undefined;
      for (let seen = 0; !websiteAnswer;) {
        const left = wholeMs - (Date.now() - websiteAskedAt);
        const events = await untilValue(
          left <= stepMs
            ? `verified website edit — the whole edit within ${wholeMs}ms`
            : `verified website edit — its next step within ${stepMs}ms (${seen} step events so far)`,
          async () => received,
          (events) => events.some(isWebsiteAnswer) || steps(events) > seen,
          { timeoutMs: Math.min(stepMs, left), describe: websiteSteps },
        );
        websiteAnswer = events.find(isWebsiteAnswer);
        seen = steps(events);
      }
      expect(websiteAnswer.payload, JSON.stringify(websiteSteps(received), null, 1)).toMatchObject({
        text: "The horse joke is live on your website.",
      });
      const published = await fetch(call.websiteUrl);
      expect(published).toMatchObject({ status: 200 });
      expect(await published.text()).toContain("bad stable manners");
      const subscriptions = await call.itx.subscriptions.list();
      for (const name of ["voice-agent", "agent"]) {
        expect(
          subscriptions.find((row: { name: string }) => row.name === name)?.hostedFacet,
        ).toMatchObject({ name, restarts: 0 });
      }
      expect(
        received.filter((event) =>
          [
            "events.iterate.com/voice-agent/call-ended",
            "events.iterate.com/voice-agent/provider-error-reported",
            "events.iterate.com/voice-agent/provider-disconnected",
          ].includes(event.type),
        ),
      ).toEqual([]);
      expect(JSON.stringify(await readAll(call.itx))).not.toContain(call.token);
    } finally {
      await call.hangUp();
    }
  },
);

realModelOnly(
  "REAL: a delegated question is answered by the agent's own model, and the live model speaks that answer",
  async () => {
    const call = await voiceCall(() => undefined);
    try {
      expect(await call.ask(TWO_PLUS_TWO)).toMatch(/\b4\b|four/i);
    } finally {
      await call.hangUp();
    }
  },
  150_000,
);

/** The sse stream of a Responses API answer: the text as one delta, then the usage. */
const answer = (text: string) =>
  sseResponse([
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { usage: { input_tokens: 1_000, output_tokens: 20 } } },
  ]);

/** One call on a fresh project with the agents app and this checkout's voice installed, dialled to
 *  the fixture provider (another project's config worker), accepted, and the audio proven to flow
 *  both ways. `model` builds the fake agent model lent to the call's context, or none for the real
 *  one. The call is a screen device's, so the press adds the screen guide too. */
async function voiceCall(model: (call: { websiteUrl: string }) => FakeAi | undefined) {
  const slug = freshDnsSafeProjectSlug("voice");
  const user = { email: `voice-${runId()}@example.com` };
  const projectId = await registerProject(slug, user);
  const root = openItx(projectId);
  // The provider fixture is ANOTHER project's config worker: this project's own config worker is
  // the website the agent rewrites, and every host of a project reaches it.
  const providerSlug = freshDnsSafeProjectSlug("voice-provider");
  const providerProjectId = await registerProject(providerSlug, user);
  const providerUrl = projectUrl({ project: providerSlug }).href;
  const { token } = await oauthSession(providerProjectId, user);
  const websiteUrl = projectUrl({ project: slug }).href;
  // Each question is one microphone frame of its own level, which the fixture hears as the words.
  const questions = [CLOCK, WEBSITE, TWO_PLUS_TWO].map((text, index) => ({
    text,
    frame: pcmFrame(3_000 + 600 * index),
  }));
  // The fixture uses a real project OAuth bearer as its provider credential. Ingress verifies
  // it before the fixture sees the principal; the loaded voice code only sees getSecret(...).
  await root.secrets.set("/secrets/openai", token, { urls: [providerUrl] });
  await publishConfigWorker(openItx(providerProjectId), [
    "itx",
    "builtins",
    ["cd", "/provider"],
    "builtins",
    "workers",
    [
      "get",
      {
        source: {
          "package.json": '{"main":"worker.js"}',
          "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const QUESTIONS = ${JSON.stringify(questions)};
export default class extends WorkerEntrypoint {
  async fetch(request) {
    if (!request.headers.get("x-itx-principal") || !request.headers.get("x-itx-grant")) return new Response("missing provider credential", {status: 401});
    // Unicode source in a target expanded after cd must survive the native fetch header.
    if ("東京 🌍".length !== 5) throw new Error("corrupted worker source");
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // The session timeline: the output audio sent so far, 32 bytes a millisecond.
    let timelineMs = 0;
    const audio = (delta) => {
      timelineMs += atob(delta).length / 32;
      server.send(JSON.stringify({type: "session.output_audio.delta", delta}));
    };
    server.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.type === "session.start") {
        server.send(JSON.stringify({type: "session.started"}));
      } else if (message.type === "session.input_audio.append") {
        audio(message.audio);
        const question = QUESTIONS.find(question => question.frame === message.audio);
        if (!question) return;
        server.send(JSON.stringify({type: "session.input_transcript.delta", delta: question.text, start_ms: timelineMs, end_ms: timelineMs}));
        server.send(JSON.stringify({type: "session.delegation.created", delegation: {id: "delegation-" + QUESTIONS.indexOf(question), target: "client"}}));
      } else if (message.type === "session.commentary.append") {
        // Spoken back: the words as its own transcript, then 1.3 s of silence, which closes the turn.
        server.send(JSON.stringify({type: "session.output_transcript.delta", delta: message.content, start_ms: timelineMs, end_ms: timelineMs}));
        audio(btoa("\\0".repeat(1_300 * 32)));
      }
    });
    return new Response(null, {status: 101, webSocket: client});
  }
}`,
        },
      },
    ],
  ]);

  const { "index.js": voice } = await voiceWorkspaceSource();
  const liveUrl = "https://api.openai.com/v1/live/sessions";
  expect(voice.split(liveUrl)).toHaveLength(2);
  // Voice makes no model call of its own: every delegation is the agent's.
  expect(voice).not.toContain("https://api.openai.com/v1/responses");
  await installAgents(root, agentsWorkspaceSource);
  await installVoice(root, { "index.js": voice.replace(liveUrl, providerUrl) });
  expect(await root.voice.health()).toMatchObject({ ok: true, projectId });

  const streamPath = "/agents/voice/v23/zectrix-note4/e2e";
  const activation = "voice-e2e";
  const itx = root.cd(streamPath);
  const ai = model({ websiteUrl });
  // A test runner lends the call's context its model; the rule lasts as long as this session.
  if (ai) await itx.provide("itx.ai", ai);
  const received: { type: string; payload: Record<string, unknown>; createdAt?: string }[] = [];
  await itx.subscribe({
    name: "device",
    consumes: ["*", "events.iterate.com/voice-agent/speaker-frame"],
    target: (events: unknown[]) => {
      received.push(...JSON.parse(JSON.stringify(events)));
    },
  });
  expect(await root.voice.setupVoiceAgent({ streamPath, activation, screen: true })).toEqual({
    streamPath,
  });
  // A failed dial must fail this assertion immediately, rather than silently timing out.
  const outcome = await until("voice accepted or failed", () =>
    received.find(
      (event) =>
        event.type === "events.iterate.com/voice-agent/conversation-accepted" ||
        event.type === "events.iterate.com/voice-agent/call-ended",
    ),
  );
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    type: "events.iterate.com/voice-agent/conversation-accepted",
    payload: { activation },
  });
  const micFrame = (pcm: string) =>
    itx.append({
      type: "events.iterate.com/voice-agent/mic-frame",
      ephemeral: true,
      payload: { activation, pcm },
    });
  for (const level of [1200, 2400]) {
    const pcm = pcmFrame(level);
    await micFrame(pcm);
    await until("microphone audio returned to the speaker", () =>
      received.some(
        (event) =>
          event.type === "events.iterate.com/voice-agent/speaker-frame" &&
          event.payload.pcm === pcm,
      ),
    );
  }
  const spoken = () =>
    received
      .filter((event) => event.type === "events.iterate.com/voice-agent/answer-transcribed")
      .map((event) => String(event.payload.text));
  /** Say `question` into the microphone; the fixture hears it and delegates it. */
  const say = (question: string) =>
    micFrame(questions.find(({ text }) => text === question)!.frame);
  return {
    root,
    itx,
    ai,
    received,
    streamPath,
    websiteUrl,
    providerUrl,
    token,
    spoken,
    say,
    /** Say `question` and wait for the next answer the live model speaks. */
    async ask(question: string) {
      const before = spoken().length;
      await say(question);
      // Two model turns and a script, each a few Durable Object hops.
      return until(
        `the spoken answer to ${JSON.stringify(question)}`,
        () => spoken()[before],
        30_000,
      );
    },
    hangUp: () =>
      itx.append({
        type: "events.iterate.com/voice-agent/call-ended",
        payload: { activation, reason: "e2e complete" },
      }),
  };
}

/** 100 ms of 16 kHz PCM16 at one level, base64. */
function pcmFrame(level: number) {
  const pcm = Buffer.alloc(3200);
  for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(level, index);
  return pcm.toString("base64");
}
