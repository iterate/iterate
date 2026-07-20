import { renderToReadableStream } from "react-dom/server.edge";
import { Todos } from "./app.tsx";

// Page worker only. The stateful /api entry lives in todos-app.ts so waking
// the list never has to load the React page bundle.
export default {
  async fetch(): Promise<Response> {
    const stream = await renderToReadableStream(
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Todos</title>
          <style>{`body{margin:0;background:#f8fafc;color:#0f172a}`}</style>
        </head>
        <body>
          <div id="root">
            <Todos />
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
