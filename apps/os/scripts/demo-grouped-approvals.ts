// Grouped-approvals (Approval Group) demo: configure a `hold` rule on a
// disposable localhost echo, then run a capability-host script whose
// Promise.all burst parks N egress POSTs at once — the NotificationProcessor
// debounces them into ONE `approvals-group` push, which deep-links the phone
// to the group for a single Approve-all (one Face ID).
//
// LOCAL DEV ONLY: the project DO's egress fetch runs inside the dev server's
// workerd on this laptop, so the echo only needs laptop reachability. Exact
// commands (and the phone-side setup) live in tasks/grouped-approvals.md.
//
//   doppler run --config dev -- pnpm cli demo run --project prj_…
//
// CAUTION: egress-rules-configured REPLACES the project's rule list — use a
// disposable/dev project.

import { createServer } from "node:http";
import process from "node:process";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { connectItxReady } from "iterate/node";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

type DemoOptions = {
  /** Project id (prj_…) to demo against. Its egress rule list is REPLACED. */
  project: string;
  /** Held POSTs the script fires in one Promise.all burst. */
  requests?: number;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL, then the local dev server. */
  baseUrl?: string;
};

/** Run the grouped-approvals demo burst against a local dev project. */
export async function run(options: DemoOptions) {
  const requestCount = options.requests || 12;
  const baseUrl =
    options.baseUrl ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readDevServerInfo(new URL("..", import.meta.url).pathname, { requireLive: true })?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() || "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required (run under doppler).");

  const echo = await startLocalEcho();
  const echoHost = new URL(echo.url).hostname;
  process.stdout.write(`echo listening on ${echo.url}\n`);

  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret },
    baseUrl: baseUrl.replace(/\/+$/, ""),
    projectId: options.project,
  });
  const root = itx.streams.get("/");
  const [rulesEvent] = await root.append({
    type: "events.iterate.com/project/egress-rules-configured",
    payload: {
      rules: [
        {
          ruleKey: "grouped-approvals-demo",
          description: "Grouped-approvals demo: echo POSTs need a human",
          match: { hosts: [echoHost], methods: ["POST"] },
          verdict: "hold",
          approvalTimeoutMs: 300_000,
        },
      ],
    },
  });
  for (let attempt = 0; ; attempt++) {
    const { state } = await itx.processor.snapshot();
    const rules = (state as { egressRules?: { ruleKey: string }[] }).egressRules || [];
    if (rules.some((rule) => rule.ruleKey === "grouped-approvals-demo")) break;
    if (attempt > 50) throw new Error("hold rule did not fold into the project processor");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Log the collapsed push intent when the debounce window fires, so the
  // laptop shows the same summary the phone buzzes with.
  void root
    .waitForEvent({
      afterOffset: rulesEvent!.offset,
      eventTypes: ["events.iterate.com/notification/requested"],
      timeoutMs: 120_000,
    })
    .then((event) => {
      const payload = event.payload as { body?: string; destination?: unknown };
      process.stdout.write(
        `push intent fired: ${payload.body} → ${JSON.stringify(payload.destination)}\n`,
      );
    })
    .catch(() => {});

  const agent = await itx.agents.get(`/agents/grouped-approvals-demo-${Date.now()}`).create();
  process.stdout.write(
    `firing ${requestCount} POSTs in one burst — expect ONE push ~3s later.\n` +
      `Approve all from the phone (the push deep-links to the group), then the script resolves.\n`,
  );
  const result = await agent.capabilityHost.runScript(`async () => {
    const responses = await Promise.all(
      Array.from({ length: ${requestCount} }, (_, index) =>
        fetch(${JSON.stringify(echo.url)}, { method: "POST", body: "demo " + index }),
      ),
    );
    return responses.map((response) => response.status);
  }`);

  process.stdout.write(
    `script result: ${JSON.stringify(result)}\n` +
      `echo received ${echo.received()} released request(s)\n`,
  );
  echo.close();
  // The Cap'n Web WebSocket would otherwise keep the process alive.
  process.exit(0);
}

/** A disposable localhost echo the demo's hold rule points at. */
function startLocalEcho(): Promise<{ url: string; received: () => number; close: () => void }> {
  let received = 0;
  const server = createServer((request, response) => {
    received += 1;
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, body }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        received: () => received,
        close: () => server.close(),
      });
    });
  });
}

if (isMainModule(import.meta.url)) {
  void createCli({ ...import.meta, name: "demo-grouped-approvals", jsonInput: "auto" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
