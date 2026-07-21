// A project-member-only app. Ordinary pages use auth as a partial fetch.
// /api stays an unauthenticated Cap'n Web root and authenticates explicitly
// in-band, exactly like the first-party OS API.
import {
  IterateWorkerEntrypoint,
  type ItxBinding,
  type ProjectAuthActor,
  type ProjectAuthCredentials,
  type StreamEvent,
} from "iterate/sdk";
import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/live-state";

type InternalAppState = { events: StreamEvent[] };

// The unauthenticated capability at /api. It has one door: turn the app's
// exact-origin HttpOnly cookie into an actor, then let userspace decide which
// authority that actor receives. The project itx never reaches the browser.
class PublicInternalApi extends RpcTarget {
  constructor(
    private readonly app: InternalApp,
    private readonly itxBinding: ItxBinding,
    private readonly request: Request,
  ) {
    super();
  }

  async authenticate(credentials: ProjectAuthCredentials): Promise<InternalAppSession> {
    using itx = await this.itxBinding.get();
    const actor = await itx.auth
      .get({ policy: "project-member" })
      .authenticate(this.request, credentials);
    const session = new InternalAppSession(this.app, actor);
    await session.refresh();
    return session;
  }
}

// This is the authority the app chooses to give an authenticated browser.
// It can identify itself, refresh the event projection, and subscribe to that
// projection. It cannot access arbitrary project ITX methods.
class InternalAppSession extends RpcTarget {
  readonly #state = new LiveState<InternalAppState>({ events: [] });
  readonly #liveState = new LiveStateRpcTarget(this.#state);

  constructor(
    private readonly app: InternalApp,
    private readonly actor: ProjectAuthActor,
  ) {
    super();
  }

  get me(): ProjectAuthActor {
    return this.actor;
  }

  get liveState(): LiveStateRpcTarget<InternalAppState> {
    return this.#liveState;
  }

  async refresh(): Promise<void> {
    this.#state.setState({ events: await this.app.readLatestEvents() });
  }
}

// A project-member-only app. Ordinary pages use auth as a partial fetch.
// /api stays an unauthenticated Cap'n Web root and authenticates explicitly
// in-band, exactly like the first-party OS API.
export class InternalApp extends IterateWorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      return newWorkersWebSocketRpcResponse(
        request,
        new PublicInternalApi(this, this.env.ITX, request),
      );
    }

    using itx = await this.env.ITX.get();
    const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(request);
    if (authResponse) return authResponse;

    // A null auth result leaves the original request untouched, so normal app
    // routes can still read its body. This echo route makes that contract easy
    // to exercise in the seeded browser proof.
    if (request.method === "POST" && url.pathname === "/echo") {
      return new Response(await request.text(), {
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
      });
    }

    const nonce = crypto.randomUUID().replaceAll("-", "");
    const prefix = request.headers.get("x-iterate-url-prefix") ?? "";
    const apiPath = JSON.stringify(`${prefix}/api`);
    return new Response(
      `<!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width">
            <title>Project events</title>
          </head>
          <body>
            <main>
              <h1>Latest project root events</h1>
              <p id="identity">authenticating API…</p>
              <button id="refresh" disabled>refresh over Cap'n Web</button>
              <form action="${escapeHtml(`${prefix}/_iterate/auth/logout`)}" method="post"><button>Sign out</button></form>
              <pre id="events">loading…</pre>
            </main>
            <script type="module" nonce="${nonce}">
              import { newWebSocketRpcSession } from "https://cdn.jsdelivr.net/npm/@iterate-com/capnweb@0.10.0/dist/index.js";

              const identity = document.getElementById("identity");
              const refresh = document.getElementById("refresh");
              const events = document.getElementById("events");
              const endpoint = new URL(${apiPath}, location.href);
              endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
              const publicApi = newWebSocketRpcSession(endpoint.toString());
              addEventListener("pagehide", () => publicApi[Symbol.dispose](), { once: true });

              const showError = (error) => {
                identity.textContent = error instanceof Error ? error.message : String(error);
              };
              const setRefreshing = (pending) => {
                refresh.disabled = pending;
                refresh.textContent = pending ? "refreshing…" : "refresh over Cap'n Web";
                if (pending) refresh.dataset.spinner = "true";
                else delete refresh.dataset.spinner;
              };
              try {
                const session = await publicApi.authenticate({ type: "from-server-cookie" });
                const me = await session.me;
                identity.textContent = "authenticated as " + me.userId;
                const render = async () => {
                  events.textContent = JSON.stringify(await session.liveState.get(), null, 2);
                };
                const subscription = await session.liveState.subscribe(() => {
                  void render().then(() => setRefreshing(false), (error) => {
                    setRefreshing(false);
                    showError(error);
                  });
                });
                setRefreshing(false);
                refresh.onclick = () => {
                  setRefreshing(true);
                  void (async () => {
                    try {
                      await session.refresh();
                      // LiveState deliberately suppresses no-op updates. Read
                      // the settled snapshot explicitly so a successful no-op
                      // refresh still renders and clears its pending state.
                      await render();
                    } catch (error) {
                      showError(error);
                    } finally {
                      setRefreshing(false);
                    }
                  })();
                };
                addEventListener("pagehide", () => {
                  subscription[Symbol.dispose]();
                  session[Symbol.dispose]();
                }, { once: true });
              } catch (error) { showError(error); }
            </script>
          </body>
        </html>`,
      {
        headers: {
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }

  async readLatestEvents(): Promise<StreamEvent[]> {
    using itx = await this.env.ITX.get();
    const snapshot = await itx.processor.snapshot();
    const events = await itx.streams.get("/").getEvents({
      afterOffset: Math.max(0, snapshot.offset - 25),
      limit: 500,
    });
    return events.slice(-25).reverse();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
