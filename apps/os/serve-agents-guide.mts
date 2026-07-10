// Scratch server: publishes the agent-processors HTML guide at
// https://agents.tunnels.iterate.com via captun. Reads the file per request so
// edits go live immediately. Run: doppler run --config dev -- pnpm tsx serve-agents-guide.mts
import { readFile } from "node:fs/promises";
import { createCaptunTunnel } from "captun";

const GUIDE_PATH = new URL("../../agent-llm-processors-guide.html", import.meta.url);

const tunnel = await createCaptunTunnel({
  gateway: process.env.CAPTUN_GATEWAY || "https://tunnels.iterate.com",
  name: "agents",
  token: process.env.CAPTUN_TOKEN,
  async fetch() {
    const html = await readFile(GUIDE_PATH, "utf8");
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
});

console.log(`serving agent guide at ${tunnel.url}`);
setInterval(() => {}, 60_000); // keep the process alive
