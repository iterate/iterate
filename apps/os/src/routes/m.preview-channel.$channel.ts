import { createFileRoute } from "@tanstack/react-router";

/**
 * Https interstitial for mobile preview-channel deep links. GitHub strips
 * custom-scheme hrefs (`iterate://…`) from rendered markdown, so PR/commit QR
 * codes and links point here instead; this page immediately bounces to the
 * app. Kept dependency-free and public: it leaks nothing beyond a channel
 * name, a preview env slug, and a synthetic test email, and the app itself
 * still shows a confirm screen before switching anything.
 */
export const Route = createFileRoute("/m/preview-channel/$channel")({
  server: {
    handlers: {
      GET: ({ params, request }) => {
        const { channel } = params;
        // Same alphabet CI's channelForBranch produces; anything else 404s.
        if (!/^[a-z0-9._-]{1,100}$/.test(channel)) {
          return new Response("not found", { status: 404 });
        }
        // Whitelist-forward the recommended-backend params CI bakes into PR
        // QR links (scripts/ci/publish-mobile-pr-preview.ts). `env` is an
        // envs.ts config key the app re-validates against its own preset
        // list; `email` is a test sign-in identity. Anything malformed is
        // dropped here rather than 404ing — the bare channel link must keep
        // working.
        const incoming = new URL(request.url).searchParams;
        const forwarded = new URLSearchParams();
        const env = incoming.get("env");
        if (env && /^[a-z0-9_]{1,32}$/.test(env)) forwarded.set("env", env);
        const email = incoming.get("email");
        if (email && /^[a-zA-Z0-9._+-]{1,64}@[a-zA-Z0-9.-]{1,64}$/.test(email)) {
          forwarded.set("email", email);
        }
        const deepLink = `iterate://preview-channel/${channel}${forwarded.size > 0 ? `?${forwarded.toString()}` : ""}`;
        // Attribute-context escape: the forwarded query joins params with `&`.
        const deepLinkAttr = deepLink.replaceAll("&", "&amp;");
        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0;url=${deepLinkAttr}" />
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
  <p><a href="${deepLinkAttr}">Tap here if nothing happens</a></p>
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
