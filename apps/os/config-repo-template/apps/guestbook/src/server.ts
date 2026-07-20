/**
 * Page worker: HTML shell only. No React, no SSR.
 * /client.js is served by the platform asset wrapper (named after src/client.tsx).
 * Deep links fall through here and get the same shell; wouter takes over in the browser.
 * /api is routed to GuestbookApp by the root project worker before this entry runs.
 */
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guestbook</title>
    <style>body{margin:0;background:#f5f5f4;color:#1c1917;font-family:system-ui,sans-serif}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/client.js"></script>
  </body>
</html>`;

const guestbookPage = {
  fetch(): Response {
    return new Response(SHELL, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  },
} satisfies ExportedHandler;

export default guestbookPage;
