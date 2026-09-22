// The shipped voice bundles, loaded exactly as the installer loads them. Only the provider URL
// is replaced: a real deployed WebSocket fixture speaks the small GPT-Live audio protocol below.
// This pins loaded-code admission, agent birth, inherited KV/egress, secret substitution,
// delegated scripts and audio in both directions. It does not test the model, microphones or speakers.
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { expect } from "vitest";
import { openItx, readAll, runId, until } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "./support/project-host.ts";

const T = "events.iterate.com/voice-agent/";

deployedOnly(
  "voice activation loads its hosted processors and streams audio through inherited, secret-bearing WebSocket egress",
  async () => {
    const slug = freshDnsSafeProjectSlug("voice");
    const user = { email: `voice-${runId()}@example.com` };
    const projectId = await registerProject(slug, user);
    const root = openItx(projectId);
    const providerUrl = projectUrl({ project: slug, app: "provider" }).href;
    const { token } = await oauthSession(projectId, user);
    // The fixture uses a real project OAuth bearer as its provider credential. Ingress verifies
    // it before the fixture sees the principal; the loaded voice code only sees getSecret(...).
    await root.secrets.set("/secrets/openai", token, { urls: [providerUrl] });
    await root.provide("itx.apps.provider", [
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
    // Unicode source in a rule expanded after cd must survive the native fetch header.
    if ("東京 🌍".length !== 5) throw new Error("corrupted worker source");
    if (request.method === "POST") {
      const {input} = await request.json();
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

    const bundles = await Promise.all(
      ["voice-agent.ts", "voice-delegate.ts", "worker.ts"].map(async (file) => {
        const result = await build({
          entryPoints: [new URL(`../examples/voice-agent/${file}`, import.meta.url).pathname],
          bundle: true,
          write: false,
          format: "esm",
          platform: "neutral",
          target: "es2022",
          loader: { ".md": "text" },
          external: ["./processor.js", "cloudflare:workers"],
        });
        return result.outputFiles[0]!.text;
      }),
    );
    const [voice, delegate, worker] = bundles as [string, string, string];
    const liveUrl = "https://api.openai.com/v1/live/sessions";
    expect(voice.split(liveUrl)).toHaveLength(2);
    const fixtureVoice = voice.replace(liveUrl, providerUrl);
    const responsesUrl = "https://api.openai.com/v1/responses";
    expect(delegate.split(responsesUrl)).toHaveLength(2);
    const fixtureDelegate = delegate.replace(responsesUrl, providerUrl);
    const key = (source: string) => createHash("sha256").update(source).digest("hex");
    const fixtureWorker = worker
      .replace("voice-agent:dev", `voice-agent:${key(fixtureVoice)}`)
      .replace("voice-delegate:dev", `voice-delegate:${key(fixtureDelegate)}`);
    await root.kv.put("voice-agent.js", fixtureVoice);
    await root.kv.put("voice-delegate.js", fixtureDelegate);
    await root.kv.put("worker.js", fixtureWorker);
    await root.provide("itx.voice", [
      "itx",
      "workers",
      [
        "get",
        {
          source: "itx.kv.get('worker.js')",
          cacheKey: key(fixtureWorker),
        },
      ],
    ]);

    const streamPath = "/agents/voice/e2e";
    const activation = "voice-e2e";
    const call = root.cd(streamPath);
    const received: { type: string; payload: Record<string, unknown> }[] = [];
    await call.subscribe({
      name: "device",
      consumes: ["*", `${T}spk-frame`],
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
            event.type === `${T}conversation-accepted` || event.type === `${T}conversation-ended`,
        ),
      );
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        type: `${T}conversation-accepted`,
        payload: { activation },
      });
      for (const amplitude of [1200, 2400]) {
        const pcm = Buffer.alloc(3200);
        for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(amplitude, i);
        const encoded = pcm.toString("base64");
        await call.append({
          type: `${T}mic-frame`,
          ephemeral: true,
          payload: { activation, pcm: encoded },
        });
        await until("microphone audio returned to the speaker", () =>
          received.some((event) => event.type === `${T}spk-frame` && event.payload.pcm === encoded),
        );
      }
      // The loaded delegate must execute a script in the conversation's real sandbox. Audio
      // alone missed the regression where the sandbox redirect was rejected as app-written builtins.
      const clockStarted = Date.now();
      await call.append({
        type: `${T}delegation-requested`,
        payload: {
          activation,
          conversationId: `conv_${activation}`,
          delegationId: "clock",
          transcript: [{ role: "listener", text: "What time is it in London?" }],
        },
      });
      const commentary = await until("delegated clock result", () =>
        received.find(
          (event) => event.type === `${T}commentary` && event.payload.delegationId === "clock",
        ),
      );
      expect(
        received
          .filter((event) => event.type === `${T}thinking`)
          .map((event) => event.payload.content),
      ).toEqual(["Checking the clock"]);
      const content = String(commentary.payload.content);
      expect(content).not.toContain("ERROR:");
      const clock = JSON.parse(content.replace("Script result:\n", ""));
      expect(clock.identity.path).toBe(`${streamPath}/sandbox`);
      expect(Date.parse(clock.time)).toBeGreaterThanOrEqual(clockStarted);
      expect(Date.parse(clock.time)).toBeLessThanOrEqual(Date.now());
      expect(
        received.filter((event) =>
          ["conversation-ended", "provider-error", "provider-disconnected"].some(
            (type) => event.type === T + type,
          ),
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
      const subscriptions = await call.subscriptions.list();
      for (const name of ["voice-agent", "voice-delegate"]) {
        expect(
          subscriptions.find((row: { name: string }) => row.name === name)?.hostedFacet,
        ).toMatchObject({ name, restarts: 0 });
      }
      expect(JSON.stringify(await readAll(call))).not.toContain(token);
    } finally {
      await call.append({
        type: `${T}conversation-ended`,
        payload: { activation, reason: "e2e complete" },
      });
    }
  },
);
