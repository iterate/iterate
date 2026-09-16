// scripts/voice-egress-probe.ts — where does a voice dial's time go on os-next?
//
// A loaded worker on a FRESH context times, in order: an HTTPS request to OpenAI through egress
// with no secret (the loopback hop + the context's fetch door + the terminal fetch), the same
// request naming the project secret (adds the secret cell), both again while the isolate is warm,
// and the real WebSocket upgrade to GPT-Live with the secret. The same two HTTPS calls are made
// from this Mac with the raw key for the baseline. Numbers are wall-clock ms inside the isolate.
//
//   OPENAI_API_KEY=… WORKER_BASE_URL=https://os.iterate2.com ADMIN_API_SECRET=… PROJECT=prj-voice \
//   pnpm exec tsx scripts/voice-egress-probe.ts
import { adminCredentials, disposeSessions, session } from "../e2e/support/client.ts";

const PROJECT = process.env.PROJECT || "prj-voice";
const MODELS = "https://api.openai.com/v1/models";

const PROBE_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const MODELS = ${JSON.stringify(MODELS)};
const LIVE = "https://api.openai.com/v1/live/sessions";
async function timed(label, init) {
  const t0 = Date.now();
  try {
    const response = await fetch(init.url, init);
    const status = response.status;
    if (response.webSocket) { try { response.webSocket.accept(); response.webSocket.close(1000, "probe"); } catch {} }
    else { try { await response.arrayBuffer(); } catch {} }
    return { label, ms: Date.now() - t0, status };
  } catch (error) {
    return { label, ms: Date.now() - t0, error: String(error).slice(0, 160) };
  }
}
export default class Probe extends WorkerEntrypoint {
  async probe() {
    const out = [];
    // THE DIAL'S OWN ORDER: the first thing this isolate does is the upgrade naming the secret —
    // a cold isolate's first loopback AND, after idle, a cold secret cell.
    out.push(await timed("1 live upgrade, with secret (first thing)", { url: LIVE, headers: { Authorization: 'Bearer getSecret("/secrets/openai")', Upgrade: "websocket" } }));
    out.push(await timed("2 live upgrade, with secret (again)", { url: LIVE, headers: { Authorization: 'Bearer getSecret("/secrets/openai")', Upgrade: "websocket" } }));
    out.push(await timed("3 models, no secret", { url: MODELS }));
    out.push(await timed("4 live upgrade, no secret (401 expected)", { url: LIVE, headers: { Upgrade: "websocket" } }));
    return out;
  }
}`,
};

async function fromMac(apiKey: string) {
  const t = async (label: string, init: RequestInit & { url: string }) => {
    const t0 = Date.now();
    const response = await fetch(init.url, init);
    await response.arrayBuffer();
    return { label, ms: Date.now() - t0, status: response.status };
  };
  return [
    await t("mac models, no key", { url: MODELS }),
    await t("mac models, with key", {
      url: MODELS,
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
    await t("mac models, with key (again)", {
      url: MODELS,
      headers: { Authorization: `Bearer ${apiKey}` },
    }),
  ];
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY unset");
  const root = session().authenticate(adminCredentials()).projects.get(PROJECT);
  await root.invoke(["itx", ["whoami"]]);
  const idleMs = Number(process.env.IDLE_MS || 0);
  for (const round of [1, 2]) {
    if (round === 2 && idleMs > 0) {
      console.log(`idling ${String(idleMs)} ms so the secret cell and the context go cold…`);
      await new Promise((r) => setTimeout(r, idleMs));
    }
    const ctx = root.cd(`/egress-probe/${Date.now().toString(36)}-${String(round)}`);
    const t0 = Date.now();
    const out = JSON.parse(
      JSON.stringify(
        await ctx.invoke(["itx", "workers", ["get", { source: PROBE_SOURCE }], ["probe"]]),
      ),
    );
    console.log(
      `round ${String(round)} (fresh context, whole call ${String(Date.now() - t0)} ms):`,
    );
    for (const row of out) console.log(`  ${JSON.stringify(row)}`);
  }
  console.log("from this Mac:");
  for (const row of await fromMac(apiKey)) console.log(`  ${JSON.stringify(row)}`);
  disposeSessions();
  process.exit(0);
}

await main();
