// The shipped voice bundles, loaded exactly as the installer loads them. Only the provider URL
// is replaced: a real deployed WebSocket fixture speaks the small GPT-Live audio protocol below.
// This pins loaded-code admission, agent birth, inherited KV/egress, secret substitution,
// delegated scripts and audio in both directions. It does not test the model, microphones or speakers.
import { expect } from "vitest";
import { buildAgentRuntime } from "../scripts/build-runtime.ts";
import { bundleVoiceSources, createVoiceInstall } from "../scripts/build-voice-install.ts";
import { ensureVoiceAgent } from "../voice/install.ts";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "../runtime/system-prompt.ts";
import { openItx, readAll, runId, until, untilValue } from "../../os/e2e/support/client.ts";
import { oauthSession } from "../../os/e2e/support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  projectUrl,
  publishConfigWorker,
  registerProject,
} from "../../os/e2e/support/project-host.ts";

deployedOnly(
  "voice activation loads its hosted processors and streams audio through inherited, secret-bearing WebSocket egress",
  async () => {
    const slug = freshDnsSafeProjectSlug("voice");
    const user = { email: `voice-${runId()}@example.com` };
    const projectId = await registerProject(slug, user);
    const root = openItx(projectId);
    // The provider fixture is ANOTHER project's config worker: this project's own config worker is
    // the website the agent rewrites below, and every host of a project reaches it.
    const providerSlug = freshDnsSafeProjectSlug("voice-provider");
    const providerProjectId = await registerProject(providerSlug, user);
    const providerUrl = projectUrl({ project: providerSlug }).href;
    const { token } = await oauthSession(providerProjectId, user);
    const websiteUrl = projectUrl({ project: slug }).href;
    const candidateSource =
      'export default {fetch() { return new Response("Because it had bad stable manners!"); }};';
    // Execute the exact candidate-probe example taught to the agent. A stale module
    // name in that prompt consumed a recovery step in the real Satellite call.
    const candidateProbe = DEFAULT_AGENT_SYSTEM_PROMPT.match(
      /`(await itx\.workers\.get\(\{ source: .*?candidateSource.*?\}\)\.fetch\(new Request\(projectUrl\)\))`/,
    )?.[1];
    expect(candidateProbe).toBeTruthy();
    const websiteScripts = [
      "return await itx.whoami();",
      'await itx.repos.create("/repos/config"); return await itx.repos.get("/repos/config").listFiles();',
      'return await itx.repos.get("/repos/config").readFile("worker.ts");',
      `const candidateSource = ${JSON.stringify(candidateSource)}; const projectUrl = ${JSON.stringify(websiteUrl)}; const response = ${candidateProbe}; const body = await response.text(); if (response.status !== 200 || !body.includes("bad stable manners")) throw new Error("candidate failed"); return body;`,
      `return await itx.repos.get("/repos/config").writeFile("worker.ts", ${JSON.stringify(candidateSource)});`,
      'return await itx.repos.get("/repos/config").readFile("worker.ts");',
      `const response = await itx.fetch(new Request(${JSON.stringify(websiteUrl)})); return {status: response.status, body: await response.text()};`,
    ];
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
            "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async fetch(request) {
    if (!request.headers.get("x-itx-principal") || !request.headers.get("x-itx-grant")) return new Response("missing provider credential", {status: 401});
    // Unicode source in a target expanded after cd must survive the native fetch header.
    if ("東京 🌍".length !== 5) throw new Error("corrupted worker source");
    if (request.method === "POST") {
      const {input} = await request.json();
      const websiteRequest = input.findLastIndex(message => message.content === "Add a horse joke to the website and verify it is live.");
      if (websiteRequest >= 0) {
        const results = input.slice(websiteRequest + 1).filter(message => message.content.startsWith("Script result:\\n"));
        if (results.some(message => message.content.includes("ERROR:"))) return new Response("website script failed: " + results.at(-1).content, {status: 500});
        const scripts = ${JSON.stringify(websiteScripts)};
        let text;
        if (results.length < scripts.length) {
          text = '<codemode status="Updating the website">\\n' + scripts[results.length] + '\\n</codemode>';
        } else {
          const published = JSON.parse(results.at(-1).content.slice("Script result:\\n".length));
          text = published.status === 200 && published.body.includes("bad stable manners") ? "The horse joke is live on your website." : "The website did not publish the joke.";
        }
        return Response.json({output: [{type: "message", content: [{type: "output_text", text}]}]});
      }
      const result = input.findLast(message => message.content.startsWith("Script result:\\n"));
      const text = result ? result.content : '<codemode status="Checking the clock">\\nreturn {time: new Date().toISOString(), identity: await itx.whoami()};\\n</codemode>\\n\\nI could not verify the time.';
      return Response.json({output: [{type: "message", content: [{type: "output_text", text}]}]});
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.type === "session.start") {
        server.send(JSON.stringify({type: "session.started"}));
      } else if (message.type === "session.input_audio.append") {
        server.send(JSON.stringify({type: "session.output_audio.delta", delta: message.audio}));
      }
    });
    return new Response(null, {status: 101, webSocket: client});
  }
}`,
          },
        },
      ],
    ]);

    const { voiceAgent: voice, voiceDelegate: delegate, worker } = await bundleVoiceSources();
    const liveUrl = "https://api.openai.com/v1/live/sessions";
    expect(voice.split(liveUrl)).toHaveLength(2);
    const fixtureVoice = voice.replace(liveUrl, providerUrl);
    const responsesUrl = "https://api.openai.com/v1/responses";
    expect(delegate.split(responsesUrl)).toHaveLength(2);
    const fixtureDelegate = delegate.replace(responsesUrl, providerUrl);
    const install = createVoiceInstall({
      agentsRuntime: await buildAgentRuntime(),
      voiceAgent: fixtureVoice,
      voiceDelegate: fixtureDelegate,
      worker,
      fontCss: "/* fixture font */",
    });
    expect(await ensureVoiceAgent(root, async () => install)).toBe("ready");

    const streamPath = "/agents/voice/e2e";
    const activation = "voice-e2e";
    const call = root.cd(streamPath);
    const received: { type: string; payload: Record<string, unknown>; createdAt?: string }[] = [];
    await call.subscribe({
      name: "device",
      consumes: ["*", "events.iterate.com/voice-agent/spk-frame"],
      target: (events: unknown[]) => {
        received.push(...JSON.parse(JSON.stringify(events)));
      },
    });
    try {
      expect(await root.voice.setupVoiceAgent({ streamPath, activation })).toEqual({ streamPath });
      // A failed dial must fail this assertion immediately, rather than silently timing out.
      const outcome = await until("voice accepted or failed", () =>
        received.find(
          (event) =>
            event.type === "events.iterate.com/voice-agent/conversation-accepted" ||
            event.type === "events.iterate.com/voice-agent/conversation-ended",
        ),
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        type: "events.iterate.com/voice-agent/conversation-accepted",
        payload: { activation },
      });
      for (const amplitude of [1200, 2400]) {
        const pcm = Buffer.alloc(3200);
        for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
        const encoded = pcm.toString("base64");
        await call.append({
          type: "events.iterate.com/voice-agent/mic-frame",
          ephemeral: true,
          payload: { activation, pcm: encoded },
        });
        await until("microphone audio returned to the speaker", () =>
          received.some(
            (event) =>
              event.type === "events.iterate.com/voice-agent/spk-frame" &&
              event.payload.pcm === encoded,
          ),
        );
      }
      // The loaded delegate must execute a script in the conversation's real sandbox. Audio
      // alone missed the regression where the sandbox redirect was rejected as app-written builtins.
      const clockStarted = Date.now();
      await call.append({
        type: "events.iterate.com/voice-agent/delegation-requested",
        payload: {
          activation,
          conversationId: `conv_${activation}`,
          delegationId: "clock",
          transcript: [{ role: "listener", text: "What time is it in London?" }],
        },
      });
      const commentary = await until("delegated clock result", () =>
        received.find(
          (event) =>
            event.type === "events.iterate.com/voice-agent/commentary-added" &&
            event.payload.delegationId === "clock",
        ),
      );
      expect(
        received
          .filter((event) => event.type === "events.iterate.com/voice-agent/thinking-added")
          .map((event) => event.payload.content),
      ).toEqual(["Checking the clock"]);
      const content = String(commentary.payload.content);
      expect(content).not.toContain("ERROR:");
      const clock = JSON.parse(content.replace("Script result:\n", ""));
      expect(clock.identity).toMatchObject({ path: `${streamPath}/sandbox` });
      expect(Date.parse(clock.time)).toBeGreaterThanOrEqual(clockStarted);
      expect(Date.parse(clock.time)).toBeLessThanOrEqual(Date.now());
      expect(
        received.filter((event) =>
          [
            "events.iterate.com/voice-agent/conversation-ended",
            "events.iterate.com/voice-agent/provider-error-reported",
            "events.iterate.com/voice-agent/provider-disconnected",
          ].includes(event.type),
        ),
      ).toEqual([]);
      const uses = (await readAll(root.cd("/secrets/openai"))).filter(
        (event) => event.type === "events.iterate.com/secret/used",
      );
      expect(uses.map((event) => event.payload)).toEqual([
        { method: "GET", url: providerUrl, status: 101 },
        { method: "POST", url: providerUrl, status: 200 },
        { method: "POST", url: providerUrl, status: 200 },
      ]);
      // Seven real sandbox scripts: candidate probe, commit, then live verification.
      // The former six-step cap discarded that last check after changing the site.
      const websiteAsked = received.length;
      const websiteAskedAt = Date.now();
      await call.append({
        type: "events.iterate.com/voice-agent/delegation-requested",
        payload: {
          activation,
          conversationId: `conv_${activation}`,
          delegationId: "website",
          transcript: [
            { role: "listener", text: "Add a horse joke to the website and verify it is live." },
          ],
        },
      });
      const isWebsiteAnswer = (event: (typeof received)[number]) =>
        event.type === "events.iterate.com/voice-agent/commentary-added" &&
        event.payload.delegationId === "website";
      // What the delegation said so far, a short line an event, each at its time since the request:
      // a wait that runs out names the script it was on, and a wrong answer names what it was given.
      const websiteSteps = (events: typeof received) => {
        const asked = events.slice(websiteAsked);
        const t0 = Date.parse(String(asked[0]?.createdAt));
        return asked
          .filter(
            (event) =>
              !event.type.endsWith("-frame") &&
              event.type !== "events.iterate.com/voice-agent/thinking-added",
          )
          .map((event) => {
            const { role, content } = event.payload as { role?: string; content?: unknown };
            const said =
              typeof content === "string"
                ? content.replace(/^<codemode[^>]*>\n|^Script result:\n/, "")
                : JSON.stringify(event.payload);
            return `+${Date.parse(String(event.createdAt)) - t0}ms ${event.type.replace("events.iterate.com/voice-agent/", "").replace("events.iterate.com/agent/", "")} ${role || ""} ${said.slice(0, 64)}`;
          });
      };
      // THE WAIT IS FOR PROGRESS, a step at a time (docs/testing.md: waits are progress-based): the
      // delegation is eight model turns and seven sandbox scripts in a row, each several Durable
      // Object hops, and the platform delivers some hops late. In the 2026-09-24 soaks (Workers
      // traces) a subrequest between two contexts of one project, both in IAD, reached its target
      // 3.1–3.2 s after it left, again and again in one run; three runs of sixty timed out while
      // still stepping, 3.4–8.9 s a step, with every step answered. So 20 s bounds A STEP — a
      // delegation that stops still fails 20 s after its last step, naming it — and the whole edit
      // has a backstop of 40 s (the slowest of those runs needed about 30).
      const stepMs = 20_000;
      const wholeMs = 40_000;
      const steps = (events: typeof received) =>
        events
          .slice(websiteAsked)
          .filter(
            (event) =>
              event.type === "events.iterate.com/voice-agent/thinking-added" ||
              event.type === "events.iterate.com/agent/context-added",
          ).length;
      let websiteAnswer: (typeof received)[number] | undefined;
      for (let seen = 0; !websiteAnswer; ) {
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
        content: "The horse joke is live on your website.",
      });
      const published = await fetch(websiteUrl);
      expect(published).toMatchObject({ status: 200 });
      expect(await published.text()).toContain("bad stable manners");
      const subscriptions = await call.subscriptions.list();
      for (const name of ["voice-agent", "voice-delegate"]) {
        expect(
          subscriptions.find((row: { name: string }) => row.name === name)?.hostedFacet,
        ).toMatchObject({ name, restarts: 0 });
      }
      expect(JSON.stringify(await readAll(call))).not.toContain(token);
    } finally {
      await call.append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation, reason: "e2e complete" },
      });
    }
  },
);
