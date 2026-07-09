// Throwaway diagnostic: read the streams of a wedged project (id via argv).
//   doppler run --config dev -- pnpm exec tsx e2e/vitest/onboarding-diagnose.mts <baseUrl> <projectId>
import { connectItx } from "../../src/itx-client.ts";

const baseUrl = (process.argv[2] ?? "http://localhost:58811").replace(/\/+$/, "");
const projectId = process.argv[3];
if (!projectId) throw new Error("pass projectId");
const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
if (!secret) throw new Error("need APP_CONFIG_ADMIN_API_SECRET (run under doppler)");

using session = connectItx({ baseUrl });
using root = session.authenticate({ type: "admin-secret", secret });
using project = root.projects.get(projectId);

for (const path of ["/", "/repos/config", "/agents/onboarding"]) {
  try {
    const events = await project.streams.get(path).getEvents({});
    console.log(`\n[${path}] ${events.length} events:`);
    for (const event of events) {
      const extra =
        event.type.includes("error") || event.type.includes("created")
          ? ` ${JSON.stringify(event.payload).slice(0, 300)}`
          : "";
      console.log(`  ${event.offset} ${event.type.replace("events.iterate.com/", "")}${extra}`);
    }
  } catch (error) {
    console.log(`\n[${path}] read failed:`, String(error).slice(0, 200));
  }
}
process.exit(0);
