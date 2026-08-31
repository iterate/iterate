// e2e/support/setup.ts — per-file setup (setupFiles): resolve the one worker's URL (provided by
// global-setup) into an env var the client helper reads, and dispose each test's capnweb sessions
// afterwards (sessions left open at teardown turn into unhandled-rejection noise — the cloudflare-os
// lesson).

import { afterEach, inject } from "vitest";
import { disposeSessions } from "./client.ts";

process.env.WORKER_BASE_URL = inject("workerBaseUrl");
process.env.DUMMY_CAPNWEB_URL = inject("dummyCapnwebUrl");

afterEach(() => disposeSessions());
