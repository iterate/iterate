// scripts/voice-install.ts — put the voice agent on an os-next project.
//
// Bundles examples/voice-agent/{voice-agent,worker}.ts (esbuild; the SDK stays the injected
// "./processor.js"), writes both bundles to the project's KV (edge-cached: a fresh conversation's
// facet loads without a git read), makes worker.js the project's root worker (`itx.worker`) and
// `itx.voice` an alias of it, and sets /secrets/openai. NOTE: this replaces any config worker the
// project already had — `itx.worker` is one rule per project.
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
  const worker = (await bundle("worker.ts")).replace(
    '"voice-agent:dev"',
    JSON.stringify(voiceAgentKey),
  );
  if (!worker.includes(voiceAgentKey))
    throw new Error("the worker's facet cache key was not substituted");
  const workerKey = `voice-worker:${hash8(worker)}`;

  const root = session().authenticate(adminCredentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  await root.secrets.set("openai", apiKey, { urls: ["https://api.openai.com"] });
  await root.kv.put("voice-agent.js", voiceAgent);
  await root.kv.put("worker.js", worker);
  await root.append(
    rule("itx.worker", [
      "itx",
      "workers",
      ["get", { source: "itx.kv.get('worker.js')", cacheKey: workerKey }],
    ]),
    rule("itx.voice", "itx.worker"),
  );
  const health = JSON.parse(JSON.stringify(await root.voice.health()));
  console.log(
    JSON.stringify(
      {
        project: PROJECT,
        voiceAgentKiB: Math.round(voiceAgent.length / 1024),
        workerKiB: Math.round(worker.length / 1024),
        voiceAgentKey,
        workerKey,
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
