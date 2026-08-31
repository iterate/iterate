// The mobile "expected native build" store and its two public faces:
//
//   PUT/DELETE /m/channel-status/<channel>  — CI writers (admin bearer)
//   GET        /m/channel-status/<channel>  — the app's staleness check (JSON)
//   GET        /m/install/<channel>         — the human install interstitial
//
// CI pushes a snapshot on every mobile publish (scripts/ci/mobile-preview.ts)
// and deletes it when a PR closes; this worker never talks to the EAS API
// (deliberately no EXPO_TOKEN in the deployment — apps/mobile/README.md).
// Snapshots live in FILES_BUCKET under the reserved `platform/` prefix
// (project file keys start with a project id, so no collision), which is
// read-after-write consistent — a phone can scan the QR the moment CI logs
// the publish.
//
// Route files stay thin (apps/os/vitest.config.ts excludes src/routes tests):
// the logic lives here and channel-status.test.ts drives these functions with
// real Requests and a fake bucket.
import { MobileChannelStatus } from "@iterate-com/shared/mobile-channel-status";
import type { AppConfig } from "~/config.ts";
import { authenticateAdminApiSecret } from "~/auth/admin.ts";

/** Same alphabet CI's channelForBranch produces; anything else 404s. */
const CHANNEL_RE = /^[a-z0-9._-]{1,100}$/;

export const channelStatusKey = (channel: string) =>
  `platform/mobile-channel-status/${channel}.json`;

/** The slice of R2Bucket this store uses — injectable in tests. */
export type StatusBucket = {
  get: (key: string) => Promise<{ text(): Promise<string> } | null>;
  put: (
    key: string,
    value: string,
    options?: { httpMetadata: { contentType: string } },
  ) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  // The app reads this cross-origin in the expo-web dev/spec lane; native
  // fetches don't care. Public data (channel names + build ids), no
  // credentials involved.
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

async function readChannelStatus(
  bucket: StatusBucket,
  channel: string,
): Promise<MobileChannelStatus | null> {
  const object = await bucket.get(channelStatusKey(channel));
  if (object === null) return null;
  const parsed = MobileChannelStatus.safeParse(JSON.parse(await object.text()));
  // A stored snapshot that no longer parses (schema moved) reads as absent —
  // both faces have an honest missing-status rendering, and the next publish
  // rewrites it.
  return parsed.success ? parsed.data : null;
}

export async function handleChannelStatusRequest(input: {
  bucket: StatusBucket;
  channel: string;
  config: Pick<AppConfig, "adminApiSecret">;
  request: Request;
}): Promise<Response> {
  const { bucket, channel, config, request } = input;
  if (!CHANNEL_RE.test(channel)) return new Response("not found", { status: 404 });

  if (request.method === "GET") {
    const status = await readChannelStatus(bucket, channel);
    if (status === null) {
      return Response.json(
        { error: "no status for this channel" },
        { headers: jsonHeaders, status: 404 },
      );
    }
    return Response.json(status, { headers: jsonHeaders });
  }

  // Writes are CI-only: same admin bearer the itx admin lane uses.
  if (!authenticateAdminApiSecret({ config }, request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (request.method === "DELETE") {
    await bucket.delete(channelStatusKey(channel));
    return Response.json({ ok: true });
  }

  if (request.method === "PUT") {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json({ error: "expected application/json" }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = MobileChannelStatus.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return Response.json({ error: issues }, { status: 400 });
    }
    if (parsed.data.channel !== channel) {
      return Response.json(
        { error: `body channel "${parsed.data.channel}" does not match URL channel "${channel}"` },
        { status: 400 },
      );
    }
    await bucket.put(channelStatusKey(channel), JSON.stringify(parsed.data, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    return Response.json({ ok: true });
  }

  return new Response("method not allowed", { status: 405 });
}

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Every build CI triggers lives in this EAS project; the fallback when we
 * have no snapshot is its builds list. */
const EAS_BUILDS_LIST_URL = "https://expo.dev/accounts/mishanustom/projects/iterate/builds";

/**
 * The install interstitial: the "native build installer that always works".
 * QR codes encode this URL (channel-stable), and it resolves the channel's
 * expected build at scan time — a QR printed three pushes ago still lands on
 * the right build. Deliberately NO auto-bounce to the app (unlike
 * /m/preview-channel/<channel>): you come here to install, and the
 * open-in-app tap must come AFTER the install anyway — the first boot of a
 * new binary clears any channel override, so switching first would be undone.
 */
export async function handleInstallPageRequest(input: {
  bucket: StatusBucket;
  channel: string;
}): Promise<Response> {
  const { bucket, channel } = input;
  if (!CHANNEL_RE.test(channel)) return new Response("not found", { status: 404 });
  const status = await readChannelStatus(bucket, channel);
  const deepLink = `iterate://preview-channel/${channel}`;

  const buildBlock = status
    ? [
        `<a class="cta" href="${escapeHtml(status.installUrl)}">${
          status.buildFinished
            ? "Install this build"
            : "Open the build page (still compiling when last published — Install appears there when it finishes)"
        }</a>`,
        `<p>Runtime <code>${escapeHtml(status.runtimeVersion.slice(0, 9))}</code> · <code>${escapeHtml(
          status.commit.slice(0, 7),
        )}</code> ${escapeHtml(status.message)}</p>`,
      ].join("\n")
    : [
        `<p>No publish snapshot for this channel — it may predate the status store, or the PR was closed.</p>`,
        `<a class="cta" href="${EAS_BUILDS_LIST_URL}">Browse EAS builds</a>`,
      ].join("\n");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Install Iterate — ${escapeHtml(channel)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0b0f; color: #e7e7ea; display: grid; place-items: center; min-height: 100dvh; margin: 0; text-align: center; }
  main { display: grid; gap: 16px; padding: 24px; max-width: 28rem; }
  a { color: #7dd3a8; font-weight: 600; }
  a.cta { border: 1px solid #2a2a33; border-radius: 10px; display: block; font-size: 18px; padding: 14px 18px; }
  p { color: #9b9ba3; font-size: 14px; margin: 0; }
  code { color: #e7e7ea; }
  h1 { font-size: 18px; margin: 0; }
</style>
</head>
<body>
<main>
  <h1>Iterate on <code>${escapeHtml(channel)}</code></h1>
  ${buildBlock}
  <p>Then come back here and open the app — installing a build lands on its own channel, and this tap switches it to <code>${escapeHtml(channel)}</code>:</p>
  <a class="cta" href="${deepLink}">Open in app</a>
  <p>Already have a compatible build installed? Just tap Open in app.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
