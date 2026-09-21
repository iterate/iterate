// e2e/support/setup.ts — per-file setup (setupFiles): resolve the one worker's URL, admin bearer and
// sign-in password (provided by global-setup) into the env vars the client helper reads, and dispose
// each test's capnweb sessions afterwards (sessions left open at teardown turn into
// unhandled-rejection noise — the cloudflare-os lesson).

import { afterEach, inject } from "vitest";
import { disposeSessions } from "./client.ts";

process.env.WORKER_BASE_URL = inject("workerBaseUrl");
process.env.ADMIN_API_SECRET = inject("adminApiSecret");
process.env.LOGIN_PASSWORD = inject("loginPassword");
process.env.PROJECT_INGRESS_ROUTING = inject("ingressRouting");
process.env.MCP_BASE_URL = inject("mcpBaseUrl");
process.env.OPENAI_API_KEY = inject("openaiApiKey");
// The run's id, the same in every worker process: client.ts folds it into every identifier a test mints.
process.env.E2E_RUN_ID = inject("runId");

afterEach(() => disposeSessions());
