// bench/tail-summary.ts — summarize a `wrangler tail --format json` capture (pretty-printed JSON
// objects, concatenated) into per-group CPU and wall-time percentiles: the DEPLOYED worker's own
// numbers, the ones that count. Usage: `tsx bench/tail-summary.ts <tail.log> [label-regex]`.
// Groups: executionModel (stateless = the /api worker, durableObject = the context DO) × the request's
// path (or the DO event kind). cpuTime/wallTime are Cloudflare's per-invocation milliseconds.

import { readFileSync } from "node:fs";

type TailEvent = {
  wallTime?: number;
  cpuTime?: number;
  executionModel?: string;
  outcome?: string;
  entrypoint?: string;
  event?: { request?: { url?: string; method?: string }; rpcMethod?: string; type?: string } | null;
};

function parseConcatenatedJson(text: string): TailEvent[] {
  const out: TailEvent[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)) as TailEvent);
        } catch {
          /* a non-JSON line (wrangler banner) — skip */
        }
        start = -1;
      }
    }
  }
  return out;
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : NaN;

function groupOf(e: TailEvent): string {
  const model = e.executionModel || "?";
  const url = e.event?.request?.url;
  if (url) return `${model} ${new URL(url).pathname}`;
  if (e.event?.rpcMethod) return `${model} rpc:${e.event.rpcMethod}`;
  if (e.event?.type) return `${model} ${e.event.type}`;
  return `${model} ${e.entrypoint || "(no request)"}`;
}

const [, , file, labelRegex] = process.argv;
if (!file) throw new Error("usage: tsx bench/tail-summary.ts <tail.log> [group-regex]");
const events = parseConcatenatedJson(readFileSync(file, "utf8"));
const groups = new Map<string, { cpu: number[]; wall: number[]; outcomes: Map<string, number> }>();
for (const e of events) {
  const group = groupOf(e);
  if (labelRegex && !new RegExp(labelRegex).test(group)) continue;
  let l = groups.get(group);
  if (!l) groups.set(group, (l = { cpu: [], wall: [], outcomes: new Map() }));
  if (typeof e.cpuTime === "number") l.cpu.push(e.cpuTime);
  if (typeof e.wallTime === "number") l.wall.push(e.wallTime);
  l.outcomes.set(e.outcome || "?", (l.outcomes.get(e.outcome || "?") ?? 0) + 1);
}
const rows = [...groups.entries()]
  .sort((a, b) => b[1].wall.length - a[1].wall.length)
  .map(([group, l]) => {
    l.cpu.sort((a, b) => a - b);
    l.wall.sort((a, b) => a - b);
    return {
      group,
      n: l.wall.length,
      cpu_p50: percentile(l.cpu, 50),
      cpu_p95: percentile(l.cpu, 95),
      cpu_sum: l.cpu.reduce((a, b) => a + b, 0),
      wall_p50: percentile(l.wall, 50),
      wall_p95: percentile(l.wall, 95),
      outcomes: [...l.outcomes.entries()].map(([k, v]) => `${k}:${v}`).join(" "),
    };
  });
console.log(`${events.length} tail events`);
console.table(rows);
