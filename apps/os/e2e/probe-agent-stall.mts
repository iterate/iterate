/**
 * Stall reproduction probe (diagnostic, not a test): hammer a deployed slot
 * with concurrent fresh-project agent asks and dump stream forensics for any
 * agent that stays inert — chasing the "fresh agent stream never delivers to
 * its processors" wedge (tasks/stream-subscriber-deliveries-stall-mid-turn.md).
 *
 *   doppler run --project os --config preview_1 -- pnpm exec tsx e2e/probe-agent-stall.mts [rounds] [concurrency]
 */
import { setTimeout as sleep } from "node:timers/promises";
import { connectItx } from "../src/itx-client.ts";

const baseUrl = (process.env.APP_CONFIG_BASE_URL ?? "").replace(/\/+$/, "");
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!baseUrl || !secret) throw new Error("need APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET");

const ROUNDS = Number(process.argv[2] ?? 8);
const CONCURRENCY = Number(process.argv[3] ?? 4);
const ASK_TIMEOUT_MS = 60_000;

const auth = { type: "admin-secret" as const, secret };

function connectAdmin() {
  const session = connectItx({ baseUrl });
  const root = session.authenticate(auth);
  return { session, root };
}

async function probeOne(tag: string): Promise<{ ok: boolean; ms: number; tag: string }> {
  const started = Date.now();
  const slug = `stall-probe-${tag}-${Math.random().toString(36).slice(2, 7)}`;
  const { session, root } = connectAdmin();
  try {
    using created = await root.projects.get(slug).create({});
    const { projectId } = await created.__describe();
    const agentPath = "/agents/probe";
    using agent = connectItx({ agentPath, auth, baseUrl, projectId });
    try {
      await agent.ask({
        message: "Reply with a chat message containing exactly the word pong.",
        timeoutMs: ASK_TIMEOUT_MS,
      });
      const ms = Date.now() - started;
      console.log(`[${tag}] OK in ${ms}ms (${slug})`);
      return { ok: true, ms, tag };
    } catch (error) {
      const ms = Date.now() - started;
      console.log(`[${tag}] STALL/FAIL after ${ms}ms (${slug}, ${projectId}): ${error}`);
      // Forensics: what does the agent stream contain, and did the project
      // worker / agent processors ever touch it?
      try {
        const events = await agent.stream.getEvents({});
        console.log(
          `[${tag}] agent stream events (${events.length}):`,
          JSON.stringify(
            events.map((event) => ({
              offset: event.offset,
              type: event.type.replace("events.iterate.com/", ""),
              source: (event as { source?: { processor?: { slug?: string } } }).source?.processor
                ?.slug,
              key: (event as { idempotencyKey?: string }).idempotencyKey,
            })),
          ),
        );
      } catch (forensicError) {
        console.log(`[${tag}] getEvents forensics failed: ${forensicError}`);
      }
      try {
        using project = connectItx({ auth, baseUrl, projectId });
        const rootEvents = await project.streams.get("/").getEvents({ limit: 50 });
        console.log(
          `[${tag}] project root stream tail:`,
          JSON.stringify(
            rootEvents.slice(-15).map((event) => ({
              offset: event.offset,
              type: event.type.replace("events.iterate.com/", ""),
            })),
          ),
        );
      } catch (forensicError) {
        console.log(`[${tag}] root stream forensics failed: ${forensicError}`);
      }
      return { ok: false, ms, tag };
    }
  } finally {
    session[Symbol.dispose]?.();
  }
}

const results: { ok: boolean; ms: number; tag: string }[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  const batch = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => probeOne(`r${round}c${i}`)),
  );
  results.push(...batch);
  const failures = results.filter((r) => !r.ok);
  console.log(
    `round ${round}/${ROUNDS}: ${batch.filter((r) => r.ok).length}/${batch.length} ok ` +
      `(cumulative ${results.length - failures.length}/${results.length}, ${failures.length} stalls)`,
  );
  if (failures.length >= 3) {
    console.log("3 stalls captured — enough forensics, stopping early");
    break;
  }
  await sleep(1000);
}
const ok = results.filter((r) => r.ok).map((r) => r.ms);
ok.sort((a, b) => a - b);
if (ok.length > 0) {
  console.log(
    `healthy ask latency: median ${ok[Math.floor(ok.length / 2)]}ms, max ${ok[ok.length - 1]}ms`,
  );
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
