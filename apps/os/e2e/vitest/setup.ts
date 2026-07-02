/**
 * itx e2e environment defaults.
 *
 * The itx e2e suites are URL-driven black boxes: point APP_CONFIG_BASE_URL at
 * any live os deployment (vite dev server or deployed worker). When unset, the
 * local dev server discovery file provides the target — same resolution the
 * rest of the os e2e lane uses. The deployment serves the itx capnweb
 * surface at /api/itx.
 */
import { fileURLToPath } from "node:url";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

const baseUrl = resolveBaseUrl(appRoot);
if (baseUrl) process.env.APP_CONFIG_BASE_URL = baseUrl;
