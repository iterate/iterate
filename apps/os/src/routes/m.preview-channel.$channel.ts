import { createFileRoute } from "@tanstack/react-router";

/**
 * Https interstitial for mobile preview-channel deep links. GitHub strips
 * custom-scheme hrefs (`iterate://…`) from rendered markdown, so PR/commit QR
 * codes and links point here instead; this page immediately bounces to the
 * app. Kept dependency-free and public: it leaks nothing beyond a channel
 * name, and the app itself still shows a confirm screen before switching.
 * Channel only — the recommended backend + test login used to ride the query
 * string here, but they now travel inside the published bundle itself
 * (apps/mobile/scripts/write-build-info.mjs), so there is nothing to forward.
 */
export const Route = createFileRoute("/m/preview-channel/$channel")({
  server: {
    handlers: {
      GET: ({ params }) => {
        const { channel } = params;
        // Same alphabet CI's channelForBranch produces; anything else 404s.
        if (!/^[a-z0-9._-]{1,100}$/.test(channel)) {
          return new Response("not found", { status: 404 });
        }
        const deepLink = `iterate://preview-channel/${channel}`;
        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0;url=${deepLink}" />
<title>Open Iterate — ${channel}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0b0f; color: #e7e7ea; display: grid; place-items: center; min-height: 100dvh; margin: 0; text-align: center; }
  a { color: #7dd3a8; font-size: 18px; font-weight: 600; }
  p { color: #9b9ba3; font-size: 14px; padding: 0 24px; }
  code { color: #e7e7ea; }
</style>
</head>
<body>
<main>
  <p>Opening the Iterate app on channel <code>${channel}</code>…</p>
  <p><a href="${deepLink}">Tap here if nothing happens</a></p>
  <p>App not installed? Grab a build from the
  <a href="https://expo.dev/accounts/mishanustom/projects/iterate/builds">EAS builds page</a>.</p>
</main>
<script>location.href = ${JSON.stringify(deepLink)};</script>
</body>
</html>`;
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      },
    },
  },
});
