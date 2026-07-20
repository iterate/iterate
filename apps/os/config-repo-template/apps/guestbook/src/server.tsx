import { renderToReadableStream } from "react-dom/server.edge";
import { Guestbook } from "./app.tsx";

// Page worker only. The stateful /api entry lives in guestbook-app.ts so
// waking the guestbook never has to load the React page bundle.
export default {
  async fetch(): Promise<Response> {
    const stream = await renderToReadableStream(
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Guestbook</title>
          <style>{`body{margin:0;background:#f5f5f4;color:#1c1917}`}</style>
        </head>
        <body>
          <div id="root">
            <Guestbook />
          </div>
          <script type="module" src="/client.js" />
        </body>
      </html>,
    );
    return new Response(stream, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler;
