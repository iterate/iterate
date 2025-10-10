import { Schedrruler } from "./schedrruler";

export type DurableObjectId = { toString(): string };

export interface DurableObjectStub<T = unknown> {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace<T> {
  idFromName(name: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

export type Env = {
  SCHEDRRULER: DurableObjectNamespace<Schedrruler>;
};

export { Schedrruler };

const HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Schedrruler playground</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: system-ui, sans-serif;
      }
      body {
        margin: 0 auto;
        padding: 2rem;
        max-width: 960px;
      }
      textarea, input, button {
        font: inherit;
      }
      textarea {
        width: 100%;
        min-height: 8rem;
      }
      pre {
        background: rgba(0, 0, 0, 0.05);
        padding: 1rem;
        overflow-x: auto;
      }
      form {
        margin-block: 1.5rem;
        padding: 1rem;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 0.5rem;
        background: rgba(255, 255, 255, 0.6);
      }
      @media (prefers-color-scheme: dark) {
        pre {
          background: rgba(255, 255, 255, 0.08);
        }
        form {
          background: rgba(0, 0, 0, 0.2);
          border-color: rgba(255, 255, 255, 0.2);
        }
      }
    </style>
  </head>
  <body>
    <h1>Schedrruler</h1>
    <p>Use the form below to post events. The latest state renders underneath.</p>
    <form id="event-form">
      <label>
        JSON payload
        <textarea name="payload">{"type":"rule_add","key":"demo","rrule":"FREQ=MINUTELY;COUNT=2","method":"log"}</textarea>
      </label>
      <div>
        <button type="submit">POST /events</button>
        <span id="form-status" role="status" aria-live="polite"></span>
      </div>
    </form>
    <section>
      <h2>Active rules</h2>
      <pre id="rules">Loading…</pre>
    </section>
    <section>
      <h2>Recent events</h2>
      <pre id="events">Loading…</pre>
    </section>
    <script type="module">
      const form = document.getElementById("event-form");
      const rules = document.getElementById("rules");
      const events = document.getElementById("events");
      const status = document.getElementById("form-status");

      async function refresh() {
        const [rulesRes, eventsRes] = await Promise.all([
          fetch("/api/state"),
          fetch("/events?limit=20"),
        ]);
        rules.textContent = await rulesRes.text();
        events.textContent = await eventsRes.text();
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const textarea = form.querySelector("textarea");
        try {
          const json = JSON.parse(textarea.value);
          const res = await fetch("/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(json),
          });
          status.textContent = res.ok ? "sent" : "error " + res.status;
        } catch (error) {
          const message =
            error && typeof (error as { message?: unknown }).message === "string"
              ? (error as { message: string }).message
              : String(error);
          status.textContent = "invalid JSON: " + message;
        }
        await refresh();
      });

      refresh().catch((error) => {
        rules.textContent = String(error);
        events.textContent = String(error);
      });
    </script>
  </body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/ui") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const id = env.SCHEDRRULER.idFromName("singleton");
    const stub = env.SCHEDRRULER.get(id);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      const forward = new Request(new URL("/", request.url), request);
      return stub.fetch(forward);
    }

    return stub.fetch(request);
  },
};
