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

/**
 * Where a board lives now that devices connect as CLIENTS.
 *
 * Firmware calls `projects.connect` with this path and its capabilities in one
 * go, so a board is its own capability-host scope instead of a name on the
 * project root. The old `itx.kit.<name>` address does not resolve any more —
 * and it fails as "no capability", which reads exactly like an unplugged
 * device. Every voicelab script goes through here so there is one place that
 * knows the shape.
 */
export function deviceClientPath(name: string) {
  return name.startsWith("/") ? name : `/clients/${BOARD_ALIASES[name] ?? name}`;
}

/**
 * Short names for boards whose client path nobody remembers.
 *
 * `havpe` is what everyone calls the Home Assistant Voice PE, in conversation,
 * in the log and in every command typed at it. Its firmware registers
 * `/clients/home-assistant-voice-preview-edition`
 * (`devices/havpe/havpe_device.c:292`), and asking for the short name fails as
 * "subscription capability-host does not exist" — which is indistinguishable
 * from an unplugged board, and was read as one for an entire evening while the
 * board sat there healthy with a 200-second uptime.
 *
 * The alias lives HERE rather than in each script because the failure is not a
 * script's: every caller that resolves a board goes through this function, so
 * this is the one place that can make the name people use be the name that
 * works.
 */
const BOARD_ALIASES: Record<string, string> = {
  havpe: "home-assistant-voice-preview-edition",
};

/**
 * The live capability a board mounted, by device name or client path.
 *
 * `connect` mounts it at the fixed name `capabilities` on the client scope,
 * and the host resolves dotted members from there — so the returned handle is
 * called exactly like the old one (`capability.conversation.start()`).
 */
export function deviceCapability<Capability>(itx: unknown, name: string): Capability {
  const clients = (itx as { clients: { get(path: string): { capabilities: Capability } } }).clients;
  return clients.get(deviceClientPath(name)).capabilities;
}
