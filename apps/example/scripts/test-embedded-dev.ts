export {};

const DEFAULT_BASE_URL = "http://127.0.0.1:17401";
const SOCKET_TIMEOUT_MS = 5_000;

function getBaseUrl() {
  const input = process.argv[2]?.trim() || process.env.EXAMPLE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return new URL(input);
}

function toWebSocketUrl(url: URL) {
  const next = new URL(url.toString());
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:";
  return next;
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = SOCKET_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function assertHttpPing(baseUrl: URL) {
  const url = new URL("/api/ping", baseUrl);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ping failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { message?: string };
  if (body.message !== "pong") {
    throw new Error(`HTTP ping returned unexpected payload: ${JSON.stringify(body)}`);
  }

  console.log(`[ok] http ping -> ${url}`);
}

async function assertPingWebSocket(baseUrl: URL) {
  const url = new URL("/api/ping/ws", toWebSocketUrl(baseUrl));

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;

      function succeed() {
        if (settled) return;
        settled = true;
        resolve();
      }

      function fail(error: Error) {
        if (settled) return;
        settled = true;
        reject(error);
      }

      ws.addEventListener("open", () => {
        ws.send("ping");
      });

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data)) as { type?: string };
          if (data.type !== "pong") {
            fail(new Error(`Ping websocket returned unexpected payload: ${String(event.data)}`));
            ws.close();
            return;
          }

          console.log(`[ok] ping websocket -> ${url}`);
          ws.close();
          succeed();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          ws.close();
        }
      });

      ws.addEventListener("error", () => {
        fail(new Error(`Ping websocket failed to connect: ${url}`));
      });

      ws.addEventListener("close", (event) => {
        if (settled) return;
        if (!event.wasClean && event.code !== 1000) {
          fail(new Error(`Ping websocket closed unexpectedly: code=${event.code}`));
        }
      });
    }),
    "Ping websocket",
  );
}

async function assertViteHmrWebSocket(baseUrl: URL) {
  const url = new URL("/", toWebSocketUrl(baseUrl));

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, "vite-hmr");
      let settled = false;

      function succeed() {
        if (settled) return;
        settled = true;
        resolve();
      }

      function fail(error: Error) {
        if (settled) return;
        settled = true;
        reject(error);
      }

      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(String(event.data)) as { type?: string };
          if (data.type !== "connected") {
            fail(
              new Error(`Vite HMR websocket returned unexpected payload: ${String(event.data)}`),
            );
            ws.close();
            return;
          }

          console.log(`[ok] vite hmr websocket -> ${url}`);
          ws.close();
          succeed();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          ws.close();
        }
      });

      ws.addEventListener("error", () => {
        fail(new Error(`Vite HMR websocket failed to connect: ${url}`));
      });

      ws.addEventListener("close", (event) => {
        if (settled) return;
        if (!event.wasClean && event.code !== 1000) {
          fail(new Error(`Vite HMR websocket closed unexpectedly: code=${event.code}`));
        }
      });
    }),
    "Vite HMR websocket",
  );
}

async function main() {
  const baseUrl = getBaseUrl();

  console.log(`Checking embedded dev server at ${baseUrl.toString()}`);

  await assertHttpPing(baseUrl);
  await assertPingWebSocket(baseUrl);
  await assertViteHmrWebSocket(baseUrl);

  console.log("All embedded dev checks passed.");
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exit(1);
});
