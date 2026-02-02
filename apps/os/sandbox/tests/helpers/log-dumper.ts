import type { SandboxHandle } from "../providers/types.ts";
import type { MockIterateOsApi, RecordedRequest } from "../mock-iterate-os-api/types.ts";
import { getContainerLogs } from "./test-helpers.ts";

export interface TestContext {
  sandbox?: SandboxHandle;
  mock?: MockIterateOsApi;
}

function formatRequest(req: RecordedRequest): string {
  if (req.type === "orpc") {
    return `${req.timestamp.toISOString()} orpc ${req.procedure}`;
  }
  return `${req.timestamp.toISOString()} ${req.method} ${req.path}`;
}

export async function dumpLogsOnFailure(ctx: TestContext): Promise<void> {
  console.log(`\n${"=".repeat(80)}`);
  console.log("TEST FAILURE - DUMPING LOGS");
  console.log("=".repeat(80));

  if (ctx.sandbox) {
    console.log("\n--- CONTAINER LOGS ---");
    try {
      const logs = await getContainerLogs(ctx.sandbox.id);
      console.log(logs);
    } catch (err) {
      console.log(
        `(container logs unavailable: ${err instanceof Error ? err.message : String(err)})`,
      );
    }

    console.log("\n--- PIDNAP LOGS (iterate-daemon) ---");
    try {
      const daemonLogs = await ctx.sandbox.exec([
        "cat",
        "/var/log/pidnap/process/iterate-daemon.log",
      ]);
      console.log(daemonLogs);
    } catch {
      console.log("(no daemon logs)");
    }

    console.log("\n--- PIDNAP LOGS (opencode) ---");
    try {
      const opencodeLogs = await ctx.sandbox.exec(["cat", "/var/log/pidnap/process/opencode.log"]);
      console.log(opencodeLogs);
    } catch {
      console.log("(no opencode logs)");
    }

    console.log("\n--- PIDNAP LOGS (egress-proxy) ---");
    try {
      const egressLogs = await ctx.sandbox.exec([
        "cat",
        "/var/log/pidnap/process/egress-proxy.log",
      ]);
      console.log(egressLogs);
    } catch {
      console.log("(no egress-proxy logs)");
    }
  }

  if (ctx.mock) {
    console.log("\n--- MOCK API REQUESTS ---");
    for (const req of ctx.mock.requests) {
      console.log(formatRequest(req));
      if (req.type === "egress" && req.body) {
        const body = JSON.stringify(req.body).slice(0, 200);
        console.log(`  body: ${body}`);
      }
    }
  }

  console.log(`\n${"=".repeat(80)}`);
}
