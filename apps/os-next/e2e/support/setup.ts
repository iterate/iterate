// e2e/support/setup.ts — per-file setup (setupFiles): resolve the one worker's URL and admin secret
// (provided by global-setup) into the env vars the client helper reads, and dispose each test's
// capnweb sessions afterwards (sessions left open at teardown turn into unhandled-rejection noise —
// the cloudflare-os lesson).

import { afterEach, inject } from "vitest";
import { disposeSessions } from "./client.ts";

process.env.WORKER_BASE_URL = inject("workerBaseUrl");
process.env.ADMIN_API_SECRET = inject("adminApiSecret");
process.env.PROJECT_HOSTNAME_BASE = inject("projectHostnameBase");
process.env.MCP_BASE_URL = inject("mcpBaseUrl");

afterEach(() => disposeSessions());
