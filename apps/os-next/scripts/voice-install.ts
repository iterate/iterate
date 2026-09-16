// scripts/voice-install.ts — put the voice agent on an os-next project.
//
// Bundles examples/voice-agent/{voice-agent,voice-backend,voice-setup}.ts (esbuild; the SDK stays
// the injected "./processor.js"), commits the three files to the project's `config` repo, points
// the project root's `itx.voice` at the setup worker (a rewrite rule), and sets /secrets/openai.
// After this, a device's `root.voice.setupVoiceAgent({ streamPath })` works with no source on it.
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

export async function installVoice(): Promise<{
  voiceAgentKey: string;
  voiceBackendKey: string;
  setupKey: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY unset");
  const [voiceAgent, voiceBackend, setupSource] = await Promise.all([
    bundle("voice-agent.ts"),
    bundle("voice-backend.ts"),
    bundle("voice-setup.ts"),
  ]);
  const voiceAgentKey = `voice-agent:${hash8(voiceAgent)}`;
  const voiceBackendKey = `voice-backend:${hash8(voiceBackend)}`;
  const setup = setupSource
    .replace('"voice-agent:dev"', JSON.stringify(voiceAgentKey))
    .replace('"voice-backend:dev"', JSON.stringify(voiceBackendKey));
  if (!setup.includes(voiceAgentKey) || !setup.includes(voiceBackendKey))
    throw new Error("the setup worker's cache keys were not substituted");
  const setupKey = `voice-setup:${hash8(setup)}`;

  const root = session().authenticate(adminCredentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  await root.secrets.set("openai", apiKey, { urls: ["https://api.openai.com"] });
  for (const [path, text] of [
    ["voice-agent.js", voiceAgent],
    ["voice-backend.js", voiceBackend],
    ["voice-setup.js", setup],
  ] as const) {
    await root.repos.writeFile("config", path, text);
    console.log(`config/${path}: ${(text.length / 1024).toFixed(0)} KiB`);
  }
  // The raw event, not `provide`: a provided rule is a session-scoped handle, undone when this
  // installer's session ends. The event IS the durable rule.
  await root.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.voice",
      target: [
        "itx",
        "workers",
        ["get", { source: "itx.repos.readFile('config', 'voice-setup.js')", cacheKey: setupKey }],
      ],
    },
  });
  const health = JSON.parse(JSON.stringify(await root.voice.health()));
  console.log(`itx.voice healthy: ${JSON.stringify(health)}`);
  return { voiceAgentKey, voiceBackendKey, setupKey };
}

if (process.argv[1]?.endsWith("voice-install.ts")) {
  console.log(JSON.stringify(await installVoice(), null, 2));
  disposeSessions();
  process.exit(0);
}
