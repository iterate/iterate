import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildAgentRuntime } from "./build-runtime.ts";

/** Build the same hosted processors the devices call, with immutable project KV keys. */
export async function buildVoiceInstall() {
  const assets = new URL("../voice/assets/", import.meta.url);
  const css = await readFile(new URL("pixel-font.css", assets), "utf8");
  const font = await readFile(new URL("press-start-2p-ascii.woff2", assets));
  const fontUrl = 'url("./press-start-2p-ascii.woff2")';
  if (!css.includes(fontUrl)) throw new Error("Screen font CSS has no local font URL to embed");
  const fontCss = css.replace(
    fontUrl,
    `url("data:font/woff2;base64,${Buffer.from(font).toString("base64")}")`,
  );
  const bundles = await Promise.all(
    ["voice-agent.ts", "voice-delegate.ts", "worker.ts"].map(async (file) => {
      const result = await build({
        entryPoints: [new URL(`../voice/${file}`, import.meta.url).pathname],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        loader: { ".md": "text" },
        external: ["./processor.js", "cloudflare:workers"],
        logLevel: "silent",
      });
      const code = result.outputFiles[0]?.text;
      if (!code) throw new Error(`No voice bundle produced for ${file}`);
      return code;
    }),
  );
  return createVoiceInstall({
    voiceAgent: bundles[0]!,
    voiceDelegate: bundles[1]!,
    worker: bundles[2]!,
    fontCss,
    agentsRuntime: await buildAgentRuntime(),
  });
}

/** Shared by the browser installer and the deployed voice protocol test's provider fixture. */
export function createVoiceInstall(sources: {
  voiceAgent: string;
  voiceDelegate: string;
  worker: string;
  fontCss: string;
  agentsRuntime: string;
}) {
  const files: Record<string, string> = {};
  const add = (name: string, source: string) => {
    const hash = createHash("sha256").update(source).digest("hex");
    const key = `kit/voice/${hash}/${name}`;
    files[key] = source;
    return { key, hash };
  };
  const fontFile = add("screen-font.css", sources.fontCss);
  const agent = add("voice-agent.js", sources.voiceAgent);
  const delegate = add("voice-delegate.js", sources.voiceDelegate);
  const worker = add(
    "worker.js",
    sources.worker
      .replaceAll("voice-agent.js", agent.key)
      .replaceAll("voice-delegate.js", delegate.key)
      .replaceAll("screen-font.css", fontFile.key)
      .replace('"voice-agent:dev"', JSON.stringify(`voice-agent:${agent.hash}`))
      .replace('"voice-delegate:dev"', JSON.stringify(`voice-delegate:${delegate.hash}`)),
  );
  if (
    files[worker.key]!.includes('"voice-agent:dev"') ||
    files[worker.key]!.includes('"voice-delegate:dev"')
  )
    throw new Error("Voice cache keys were not substituted");
  return {
    agentsRuntime: sources.agentsRuntime,
    files,
    workerKey: worker.key,
    cacheKey: `voice-worker:${worker.hash}`,
  };
}

/** Each app that installs voice serves its own copy: `public/voice-install.json`, gitignored. */
export async function writeVoiceInstall(destination: URL) {
  await writeFile(destination, JSON.stringify(await buildVoiceInstall()));
}
