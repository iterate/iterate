// The mobile "expected native build" store and its public faces (moved here
// from apps/os — kernel vs userland: this is the app's own web surface):
//
//   PUT/DELETE /m/channel-status/<channel>  — CI writers (admin bearer)
//   GET        /m/channel-status/<channel>  — the app's staleness check (JSON)
//   GET        /m/install/<channel>         — the human install interstitial
//   GET        /m/install-manifest/<channel> — the itms-services plist
//
// CI pushes a snapshot on every mobile publish (scripts/ci/mobile-preview.ts)
// and deletes it when a PR closes; this worker never talks to the EAS API
// (deliberately no EXPO_TOKEN in any deployment — apps/mobile/README.md).
// Snapshots live in this worker's own R2 bucket, which is read-after-write
// consistent — a phone can scan the QR the moment CI logs the publish.
import { MobileChannelStatus } from "@iterate-com/shared/mobile-channel-status";

/** Same alphabet CI's channelForBranch produces; anything else 404s. */
const CHANNEL_RE = /^[a-z0-9._-]{1,100}$/;

export const channelStatusKey = (channel: string) => `channel-status/${channel}.json`;

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
  // The app fetches this cross-origin when it runs as an expo web dev
  // bundle (playwright specs, local web dev); native fetches have no CORS.
  // Public data (channel names + build ids), no credentials involved.
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
  // every face has an honest missing-status rendering, and the next publish
  // rewrites it.
  return parsed.success ? parsed.data : null;
}

/** Constant-ish compare is not needed here (the secret is long and random,
 * and callers are CI); a plain equality against the deployed secret matches
 * what apps/os's authenticateAdminBearer does. */
const isAdmin = (request: Request, adminSecret: string) => {
  const match = /^bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  const token = match?.[1]?.trim() || "";
  return token.length > 0 && adminSecret.length > 0 && token === adminSecret;
};

export async function handleChannelStatusRequest(input: {
  bucket: StatusBucket;
  channel: string;
  /** The same APP_CONFIG_ADMIN_API_SECRET the CI writers hold (doppler
   * os/prd) — one secret, one rotation. */
  adminSecret: string;
  request: Request;
}): Promise<Response> {
  const { bucket, channel, adminSecret, request } = input;
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

  if (!isAdmin(request, adminSecret)) {
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

const PAGE_STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0b0f; color: #e7e7ea; display: grid; place-items: center; min-height: 100dvh; margin: 0; text-align: center; }
  main { display: grid; gap: 16px; padding: 24px; max-width: 28rem; }
  a { color: #7dd3a8; font-weight: 600; }
  a.cta { border: 1px solid #2a2a33; border-radius: 10px; display: block; font-size: 18px; padding: 14px 18px; }
  p { color: #9b9ba3; font-size: 14px; margin: 0; }
  code { color: #e7e7ea; }
  h1 { font-size: 18px; margin: 0; }`;

const htmlResponse = (html: string) =>
  new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * Https interstitial for preview-channel deep links. GitHub strips
 * custom-scheme hrefs (`iterate://…`) from rendered markdown, so PR/commit
 * OTA links point here; this page immediately bounces to the app. Public:
 * it leaks nothing beyond a channel name, and the app itself still shows a
 * confirm screen before switching.
 */
export function handlePreviewChannelRequest(input: { channel: string }): Response {
  const { channel } = input;
  if (!CHANNEL_RE.test(channel)) return new Response("not found", { status: 404 });
  const deepLink = `iterate://preview-channel/${channel}`;
  return htmlResponse(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0;url=${deepLink}" />
<title>Open Iterate — ${escapeHtml(channel)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <p>Opening the Iterate app on channel <code>${escapeHtml(channel)}</code>…</p>
  <p><a href="${deepLink}">Tap here if nothing happens</a></p>
  <p>App not installed? <a href="/install/${escapeHtml(channel)}">Install it first</a>.</p>
</main>
<script>location.href = ${JSON.stringify(deepLink)};</script>
</body>
</html>`);
}

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
  /** The deployment's own origin (from the request URL) — the itms manifest
   * URL must point back at the same host that served this page. */
  origin: string;
}): Promise<Response> {
  const { bucket, channel, origin } = input;
  if (!CHANNEL_RE.test(channel)) return new Response("not found", { status: 404 });
  const status = await readChannelStatus(bucket, channel);
  const deepLink = `iterate://preview-channel/${channel}`;
  // Install in place when the snapshot carries everything the manifest
  // needs: iOS fetches /m/install-manifest/<channel> over https and installs
  // to the home screen without ever leaving this page. Otherwise (build
  // still compiling, or a pre-itms snapshot) the expo.dev build page — whose
  // own Install tap is the same itms mechanism, minus the staying-here part
  // — remains the way in.
  const installable =
    status !== null &&
    status.buildFinished &&
    status.ipaUrl &&
    status.bundleId &&
    status.appVersion;
  const itmsHref = `itms-services://?action=download-manifest&amp;url=${encodeURIComponent(
    `${origin}/m/install-manifest/${channel}`,
  )}`;

  const buildBlock = status
    ? [
        installable
          ? `<a class="cta" href="${itmsHref}">Install this build</a>`
          : `<a class="cta" href="${escapeHtml(status.installUrl)}">${
              status.buildFinished
                ? "Install this build"
                : "Open the build page (still compiling when last published — Install appears there when it finishes)"
            }</a>`,
        ...(installable
          ? [
              `<p>Installs in place — watch your home screen. <a href="${escapeHtml(status.installUrl)}">Build details</a>.</p>`,
            ]
          : []),
        `<p>Runtime <code>${escapeHtml(status.runtimeVersion.slice(0, 9))}</code> · <code>${escapeHtml(
          status.commit.slice(0, 7),
        )}</code> ${escapeHtml(status.message)}</p>`,
      ].join("\n")
    : [
        `<p>No publish snapshot for this channel — it may predate the status store, or the PR was closed.</p>`,
        `<a class="cta" href="${EAS_BUILDS_LIST_URL}">Browse EAS builds</a>`,
      ].join("\n");

  return htmlResponse(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Install Iterate — ${escapeHtml(channel)}</title>
<style>${PAGE_STYLE}</style>
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
</html>`);
}

/**
 * The itms-services manifest iOS fetches when the install page's button is
 * tapped: a plist naming the app (bundle id + version) and where its .ipa
 * lives (the stable expo.dev artifact URL from the snapshot). Must be https
 * with an XML content type or iOS refuses ("cannot connect to <host>").
 * 404 when the snapshot is missing or predates the itms fields — the page
 * only renders the itms button when they're all present, so a 404 here
 * means a snapshot changed between page load and tap.
 */
export async function handleInstallManifestRequest(input: {
  bucket: StatusBucket;
  channel: string;
}): Promise<Response> {
  const { bucket, channel } = input;
  if (!CHANNEL_RE.test(channel)) return new Response("not found", { status: 404 });
  const status = await readChannelStatus(bucket, channel);
  if (status === null || !status.ipaUrl || !status.bundleId || !status.appVersion) {
    return new Response("no installable manifest for this channel", { status: 404 });
  }
  // escapeHtml doubles as an XML escaper (&, <, >, ").
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeHtml(status.ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeHtml(status.bundleId)}</string>
        <key>bundle-version</key>
        <string>${escapeHtml(status.appVersion)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>Iterate</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" },
  });
}
