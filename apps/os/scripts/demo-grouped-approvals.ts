// Thin CLI wrapper around the "grouped-approvals-demo" catalogue example
// (src/itx/examples-source.ts) — the SAME entry the phone's Examples screen
// runs, executed through the same capabilityHost.runScript door, so there is
// one source of truth for the demo. Works against any deployment: the burst
// targets our deployed dummy-petshop service, not a laptop-local echo.
//
//   doppler run --config dev -- pnpm cli demo-grouped-approvals run --project prj_…
//
// CAUTION: the example REPLACES the project's egress rule list — use a
// disposable/dev project.

import process from "node:process";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { connectItxReady } from "iterate/node";
import { ITX_EXAMPLES } from "../src/itx/examples.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

const NOTIFICATION_REQUESTED = "events.iterate.com/notification/requested";

type DemoOptions = {
  /** Project id (prj_…) to demo against. Its egress rule list is REPLACED. */
  project: string;
  /** Held GETs the script fires in one Promise.all burst. */
  requests?: number;
  /** Override the held demo URL (defaults to the example's dummy-petshop target). */
  url?: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL, then the local dev server. */
  baseUrl?: string;
};

/** Run the grouped-approvals catalogue example against a project, from the laptop. */
export async function run(options: DemoOptions) {
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

  const example = ITX_EXAMPLES.find((entry) => entry.id === "grouped-approvals-demo");
  if (!example) throw new Error("grouped-approvals-demo is missing from the example catalogue");

  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret },
    baseUrl: baseUrl.replace(/\/+$/, ""),
    projectId: options.project,
  });
  const root = itx.streams.get("/");

  // Log the collapsed push intent when the debounce window fires, so the
  // laptop shows the same summary the phone buzzes with. Start past any
  // pre-existing intents on a reused project.
  let lastIntentOffset = 0;
  while (true) {
    const page = await root.getEvents({
      afterOffset: lastIntentOffset,
      eventTypes: [NOTIFICATION_REQUESTED],
    });
    if (page.length === 0) break;
    lastIntentOffset = page.at(-1)!.offset;
  }
  void root
    .waitForEvent({
      afterOffset: lastIntentOffset,
      eventTypes: [NOTIFICATION_REQUESTED],
      predicate: (event) =>
        (event.payload as { destination?: { kind?: string } }).destination?.kind ===
        "approvals-group",
      timeoutMs: 300_000,
    })
    .then((event) => {
      const payload = event.payload as { body?: string; destination?: unknown };
      process.stdout.write(
        `push intent fired: ${payload.body} → ${JSON.stringify(payload.destination)}\n`,
      );
    })
    .catch(() => {});

  const vars = {
    ...(options.requests === undefined ? {} : { requests: options.requests }),
    ...(options.url === undefined ? {} : { url: options.url }),
  };
  process.stdout.write(
    `running catalogue example "${example.id}" (${JSON.stringify(vars)}) — the burst fires\n` +
      `after a ~6s rule-propagation wait; expect ONE push ~3s after the burst. Approve all\n` +
      `from the phone (the push deep-links to the group), then the script resolves.\n`,
  );
  // The same run-script envelope the phone's Examples screen and the e2e
  // matrix use (e2e/test-support/run-example.ts runScriptEnvelope).
  const execution = await itx.capabilityHost.runScript(
    `async (itx) => {\nconst vars = ${JSON.stringify(vars)};\n${example.code}\n}`,
  );

  process.stdout.write(`script result: ${JSON.stringify(execution.result)}\n`);
  // The Cap'n Web WebSocket would otherwise keep the process alive.
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  void createCli({ ...import.meta, name: "demo-grouped-approvals", jsonInput: "auto" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
