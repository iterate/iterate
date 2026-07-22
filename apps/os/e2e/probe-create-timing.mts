/**
 * Create-latency probe (diagnostic, not a test): time the create-project
 * critical path exactly as the dashboard form drives it — connect,
 * projects.get(slug).create({}, { readiness: "exists" }) with identity()
 * pipelined through it — and print per-phase client timings. Pair with
 * `wrangler tail <os-worker> --format json | grep create-timing` for the
 * server-side step breakdown (tasks/os-cold-create-latency.md has the
 * reference numbers).
 *
 *   doppler run --project os --config prd -- pnpm exec tsx e2e/probe-create-timing.mts [runs]
 */
import { connectItx } from "iterate/node";

const baseUrl = (process.env.APP_CONFIG_BASE_URL ?? "").replace(/\/+$/, "");
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!baseUrl || !secret) throw new Error("need APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET");

const runs = Number(process.argv[2] ?? 3);

for (let i = 0; i < runs; i++) {
  const slug = `createperf-${Date.now().toString(36)}-${i}`;
  const t0 = performance.now();
  using session = connectItx({ baseUrl, auth: { type: "admin-secret", secret } });
  await session.__describe();
  const t1 = performance.now();
  using project = session.projects.get(slug).create({}, { readiness: "exists" });
  const identity = await project.identity();
  const t2 = performance.now();
  console.log(
    JSON.stringify({
      run: i,
      slug: identity.slug,
      connectMs: Math.round(t1 - t0),
      createMs: Math.round(t2 - t1),
      totalMs: Math.round(t2 - t0),
    }),
  );
}
