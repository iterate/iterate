import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";
import type { TodoListDurableObject } from "./todo-list.ts";

export { TodoListDurableObject } from "./todo-list.ts";

// wrangler.jsonc declares exactly this binding; the app is small enough that
// a hand-written env type beats generated worker configuration types.
const env = workerEnv as unknown as {
  TODO_LIST: DurableObjectNamespace<TodoListDurableObject>;
};

const LIST_API = /^\/api\/lists\/([a-z0-9][a-z0-9-]{0,63})$/;

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    // Cap'n Web per list: the WebSocket upgrade terminates INSIDE the list's
    // Durable Object (todo-list.ts fetch), so the session and its live-state
    // subscriptions live where the data lives.
    const match = LIST_API.exec(url.pathname);
    if (match) {
      return env.TODO_LIST.getByName(match[1]!).fetch(request);
    }

    if (url.pathname === "/api/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Everything else is the TanStack Start app: SSR routes + client assets.
    return handler.fetch(request);
  },
});
