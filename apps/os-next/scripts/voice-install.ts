// scripts/voice-install.ts — put the voice agent on an os-next project.
//
// Bundles examples/voice-agent/{voice-agent,voice-delegate,worker}.ts (esbuild; the SDK stays the injected
// "./processor.js"), writes the three bundles to the project's KV (edge-cached: a fresh
// conversation's facets load without a git read), mounts worker.js at `itx.voice` (the project's
// own root worker, `itx.worker`, is untouched), sets /secrets/openai, and runs one throwaway
// conversation so the loader has both facet isolates warm before the first real press.
//
//   OPENAI_API_KEY=… WORKER_BASE_URL=https://os.iterate2.com ADMIN_API_SECRET=… \
//   PROJECT=prj-voice pnpm exec tsx scripts/voice-install.ts
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { adminCredentials, disposeSessions, session } from "../e2e/support/client.ts";

const PROJECT = process.env.PROJECT || "prj-voice";

async function bundle(file: string): Promise<string> {
  const result = await build({
    entryPoints: [new URL(`../examples/voice-agent/${file}`, import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["./processor.js", "cloudflare:workers"],
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error(`esbuild produced no output for ${file}`);
  return code;
}

const hash8 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** A durable rewrite rule (a provided one is undone when this installer's session ends). */
const rule = (match: string, target: unknown) => ({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: { match, target },
});

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY unset");
  const voiceAgent = await bundle("voice-agent.ts");
  const voiceAgentKey = `voice-agent:${hash8(voiceAgent)}`;
  const voiceDelegate = await bundle("voice-delegate.ts");
  const voiceDelegateKey = `voice-delegate:${hash8(voiceDelegate)}`;
  const worker = (await bundle("worker.ts"))
    .replace('"voice-agent:dev"', JSON.stringify(voiceAgentKey))
    .replace('"voice-delegate:dev"', JSON.stringify(voiceDelegateKey));
  if (!worker.includes(voiceAgentKey) || !worker.includes(voiceDelegateKey))
    throw new Error("a facet cache key was not substituted into the worker");
  const workerKey = `voice-worker:${hash8(worker)}`;

  const root = session().authenticate(adminCredentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  await root.secrets.set("openai", apiKey, { urls: ["https://api.openai.com"] });
  await root.kv.put("voice-agent.js", voiceAgent);
  await root.kv.put("voice-delegate.js", voiceDelegate);
  await root.kv.put("worker.js", worker);
  // `itx.voice` is its own mount: the project's root worker (`itx.worker`, its repo's worker.ts)
  // stays whatever it was, so a real project keeps its website and apps.
  await root.append(
    rule("itx.voice", [
      "itx",
      "workers",
      ["get", { source: "itx.kv.get('worker.js')", cacheKey: workerKey }],
    ]),
  );
  const health = JSON.parse(JSON.stringify(await root.voice.health()));

  // Warm both facet isolates under their new cache keys with ONE throwaway conversation, so the
  // first real press does not pay the cold load (measured 2.3s vs 1.3s to accepted). Install-time
  // only; the dial fails without a mic, which is fine — the isolates are what we are warming.
  const warmPath = `/agents/voice/warm-${hash8(worker)}`;
  const warmStartedAt = Date.now();
  await root.voice.setupVoiceAgent({ streamPath: warmPath, activation: `warm-${hash8(worker)}` });
  const warmupMs = Date.now() - warmStartedAt;
  await root.cd(warmPath).append({
    type: "events.iterate.com/voice-agent/conversation-ended",
    payload: { activation: `warm-${hash8(worker)}`, reason: "install warm-up" },
  });
  console.log(
    JSON.stringify(
      {
        project: PROJECT,
        voiceAgentKiB: Math.round(voiceAgent.length / 1024),
        voiceDelegateKiB: Math.round(voiceDelegate.length / 1024),
        workerKiB: Math.round(worker.length / 1024),
        voiceAgentKey,
        voiceDelegateKey,
        workerKey,
        warmupMs,
        health,
      },
      null,
      2,
    ),
  );
  disposeSessions();
  process.exit(0);
}

await main();
