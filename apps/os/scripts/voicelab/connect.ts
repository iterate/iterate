// Shared itx connection for voicelab commands — same auth surface as `pnpm cli itx`:
// APP_CONFIG_BASE_URL + APP_CONFIG_ADMIN_API_SECRET from the Doppler config, falling
// back to the local dev server. Each call opens its OWN Cap'n Web WebSocket, which
// matters for the bench: append and subscribe legs must not share a socket when
// measuring per-socket ceilings.
import process from "node:process";
import { connectItxReady } from "iterate/node";
import { readDevServerInfo } from "../lib/dev-server-info.ts";

/** Options accepted by every voicelab command that talks to OS. */
export interface VoicelabConnectOptions {
  /**
   * Project slug or `prj_` id to connect into.
   *
   * `projects.get` resolves either, so nothing here has to know which it was
   * given — and a slug is what a person actually remembers.
   */
  project: string;
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or the local dev server. */
  baseUrl?: string;
}

export function resolveVoicelabBaseUrl(options: Pick<VoicelabConnectOptions, "baseUrl">) {
  const baseUrl =
    options.baseUrl ??
    process.env.APP_CONFIG_BASE_URL?.trim() ??
    readDevServerInfo(new URL("../..", import.meta.url).pathname, {
      requireLive: true,
    })?.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  return baseUrl;
}

export async function connectProject(options: VoicelabConnectOptions) {
  const baseUrl = resolveVoicelabBaseUrl(options);
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");
  return await connectItxReady({
    auth: { type: "admin-secret", secret },
    baseUrl,
    projectId: options.project,
  });
}
