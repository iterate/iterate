export {};

const SOCKET_TIMEOUT_MS = 5_000;
const HMR_NEGATIVE_TIMEOUT_MS = 1_500;

type Mode = "dev" | "start";

function getMode(): Mode {
  const input = process.argv[2]?.trim();
  if (input === "start") return "start";
  return "dev";
}

function getBaseUrl() {
  const mode = getMode();
  const defaultBaseUrl = mode === "start" ? "http://localhost:4173" : "http://localhost:5173";
  const input = process.argv[3]?.trim() || process.env.EXAMPLE_BASE_URL?.trim() || defaultBaseUrl;
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

async function assertViteHmrWebSocketUnavailable(baseUrl: URL) {
  const url = new URL("/", toWebSocketUrl(baseUrl));

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, "vite-hmr");
    let settled = false;

    function succeed() {
      if (settled) return;
      settled = true;
      console.log(`[ok] vite hmr websocket unavailable -> ${url}`);
      resolve();
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      reject(error);
    }

    const timer = setTimeout(() => {
      ws.close();
      succeed();
    }, HMR_NEGATIVE_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      fail(new Error(`Vite HMR websocket unexpectedly connected: ${url}`));
      ws.close();
    });

    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      fail(new Error(`Vite HMR websocket unexpectedly sent data: ${String(event.data)}`));
      ws.close();
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      succeed();
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      succeed();
    });
  });
}

async function main() {
  const mode = getMode();
  const baseUrl = getBaseUrl();

  console.log(`Checking example ${mode} server at ${baseUrl.toString()}`);

  await assertHttpPing(baseUrl);
  await assertPingWebSocket(baseUrl);

  if (mode === "dev") {
    await assertViteHmrWebSocket(baseUrl);
  } else {
    await assertViteHmrWebSocketUnavailable(baseUrl);
  }

  console.log(`All example ${mode} checks passed.`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exit(1);
});
