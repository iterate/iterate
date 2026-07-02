/**
 * Engine-suite environment defaults.
 *
 * The next-engine e2e suites are URL-driven black boxes: point ITX_BASE_URL at
 * any live os deployment (vite dev server or deployed worker). When unset, the
 * local dev server discovery file provides the target — same resolution the
 * rest of the os e2e lane uses. During coexistence the os deployment serves
 * the next capnweb surface at /api/itx.
 */
import { fileURLToPath } from "node:url";
import { readLocalDevServerInfo } from "@iterate-com/shared/alchemy/local-dev-server";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));

if (!process.env.ITX_BASE_URL) {
  const baseUrl =
    process.env.APP_CONFIG_BASE_URL ??
    readLocalDevServerInfo(appRoot, { requireLive: true })?.baseUrl;
  if (baseUrl) process.env.ITX_BASE_URL = baseUrl.replace(/\/+$/, "");
}
