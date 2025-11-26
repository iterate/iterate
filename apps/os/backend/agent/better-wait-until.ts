import { Agent, type Connection, type ConnectionContext } from "agents";
import { DurableObject } from "cloudflare:workers";
import { logger } from "../tag-logger.ts";

// Debug logging helpers
let _debugEnabled = false;
function logDebug(message: string, ...args: unknown[]) {
  if (_debugEnabled) {
    logger.info(`[better-wait-until] ${message}`, ...args);
  }
}

function logError(message: string, data?: unknown) {
  logger.error(`[better-wait-until] ${message}`, data);
}

export function enableDebug(): void {
  _debugEnabled = true;
}

export function disableDebug(): void {
  _debugEnabled = false;
}

// WebSocket endpoint configuration
export const BETTER_WAIT_UNTIL_WEBSOCKET_ENDPOINT = new URL(
  "https://fake/better-wait-until/websocket",
);
export const betterWaitUntilWebsocketPath = BETTER_WAIT_UNTIL_WEBSOCKET_ENDPOINT.pathname;

function getBetterWaitUntilUrl(className: string): URL {
  return new URL(BETTER_WAIT_UNTIL_WEBSOCKET_ENDPOINT.toString() + `?className=${className}`);
}

// We modiffy the instance to accept better wait until requests and handle them without breaking Agents/PartyKit functionality
export function monkeyPatchAgentWithBetterWaitUntilSupport(instance: Agent<any, any>): void {
  const originalFetch = instance.fetch;
  const originalWebSocketMessage = instance.webSocketMessage;

  // Define instance-specific fetch wrapper with dynamic `this`
  Object.defineProperty(instance, "fetch", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: async function (this: DurableObject<any>, request: Request): Promise<Response> {
      // returns null if the request is not a better wait until request
      const betterWaitUntilResponse = await acceptBetterWaitUntilWebSocketIfValid(
        this["ctx"],
        request,
      );
      if (betterWaitUntilResponse) {
        return betterWaitUntilResponse;
      }
      if (typeof originalFetch === "function") {
        return await originalFetch.call(this, request);
      }
      return new Response("Not found", { status: 404 });
    },
  });

  // Define instance-specific webSocketMessage wrapper with dynamic `this`
  Object.defineProperty(instance, "webSocketMessage", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: async function (this: DurableObject<any>, ws: WebSocket, message: string) {
      if (message.startsWith("better-wait-until-ping ")) {
        logDebug("Server-side received:", message);
        ws.send("pong from server");
        return;
      }
      if (typeof originalWebSocketMessage === "function") {
        return await originalWebSocketMessage.call(this, ws, message);
      }
    },
  });

  const oldWaitUntil = instance["ctx"].waitUntil;
  Object.defineProperty(instance["ctx"], "waitUntil", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (promise: Promise<unknown>) {
      return oldWaitUntil?.call(instance["ctx"], betterAwait(instance, promise));
    },
  });

  const originalBroadcast = instance.broadcast;
  Object.defineProperty(instance, "broadcast", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (this: Agent<any, any>, msg: string, without?: string[]) {
      const exclude: string[] = without ?? [];
      // Don't send broadcast messages to wait-until connections.
      for (const connection of this.getConnections()) {
        if (connection.url?.includes(betterWaitUntilWebsocketPath)) {
          exclude.push(connection.id);
        }
      }
      return originalBroadcast.call(this, msg, exclude);
    },
  });

  const originalOnConnect = instance.onConnect;
  Object.defineProperty(instance, "onConnect", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function (this: Agent<any, any>, connection: Connection, ctx: ConnectionContext) {
      // don't pass through better wait until connections to the agent class, it will confuse it.
      if (connection.url?.includes(betterWaitUntilWebsocketPath)) {
        return;
      }
      if (typeof originalOnConnect === "function") {
        return originalOnConnect.call(this, connection, ctx);
      }
    },
  });
}

function acceptBetterWaitUntilWebSocketIfValid(
  state: DurableObjectState,
  request: Request,
): Response | null {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith(betterWaitUntilWebsocketPath) ||
    request.headers.get("Upgrade") !== "websocket"
  ) {
    return null;
  }
  try {
    const [client, server] = Object.values(new WebSocketPair());

    // Accept the server side with hibernation
    state.acceptWebSocket(server, ["better-wait-until"]);

    // Add fake attachment to the server side to keep PartyKit from freaking out
    server.serializeAttachment({
      __pk: {
        id: -1,
        uri: request.url,
      },
      __user: null,
    });

    // Return the client side
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch (err) {
    logError("Error accepting better wait until web socket", { err });
    return new Response("Error accepting better wait until web socket", { status: 500 });
  }
}

/**
 * Actually wait until a promise resolves.
 * Cloudflare Durable Object runtime will kill in-flight promises within about 2 minutes (if not less) after the last network request.
 *
 * This function will keep the Durable Object alive while your promise is still running by sending a no-op fetch to it every 10 seconds.
 *
 * Set a timeout to prevent the function from running forever in cases where the promise never resolves.
 *
 * @param promise - The promise to await
 * @param options - The options for the function
 * @param options.timeout - A date after which the retries will stop. To prevent the function from running forever in cases where the provided promise never resolves
 * @returns A promise that resolves when the input promise resolves
 */
function betterAwait(
  durableObject: DurableObject,
  promise: Promise<unknown>,
  options: { timeout?: Date; logWarningAfter?: Date; logErrorAfter?: Date } = {},
): Promise<void> {
  logDebug("promise received", {
    className: durableObject.constructor?.name ?? "",
    options,
  });
  const start = Date.now();
  const logWarningAt = options.logWarningAfter?.getTime() ?? Date.now() + 1000 * 60 * 15; // 15 minutes
  const logErrorAt = options.logErrorAfter?.getTime() ?? Date.now() + 1000 * 60 * 60; // 1 hour
  if (!options.timeout) {
    options.timeout = new Date(Date.now() + 1000 * 60 * 60 * 2); // 2 hours
  }

  // access private property haha!
  const ctx = durableObject["ctx"];

  const exportsNs = (ctx as any).exports;
  if (!exportsNs) throw new Error("No exports on DurableObject context.");

  const className: string = durableObject.constructor?.name ?? "";
  const durableObjectNamespace = exportsNs[className] as DurableObjectNamespace;
  if (!durableObjectNamespace) {
    throw new Error(`No exports namespace for DurableObject class ${className}`);
  }

  // Make a WebSocket connection to ourselves
  const websocketPromise = new Promise<Response>((resolve, reject) => {
    function generateWebSocketKey() {
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      return btoa(String.fromCharCode(...randomBytes));
    }
    const response = durableObjectNamespace
      .get(ctx.id)
      .fetch(getBetterWaitUntilUrl(className), {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": generateWebSocketKey(),
          "Sec-WebSocket-Version": "13",
        },
      })
      .then((response) => {
        if (response.webSocket) {
          response.webSocket.accept();
          logDebug("WebSocket accepted");
          resolve(response);
        } else {
          logError("WebSocket not accepted", { response });
          throw new Error("WebSocket not accepted");
        }
      })
      .catch((err) => {
        logError("Error accepting WebSocket", { err });
        reject(err);
      });
    return response;
  });

  let loggedWarning = false;
  let lastLoggedErrorAt = 0;

  let closureFlag = false;
  let hasCleanedUp = false;
  const requestCleanup = (): void => {
    if (hasCleanedUp) return;
    hasCleanedUp = true;
    // If socket is already available, close immediately. Otherwise, mark for close upon accept.
    websocketPromise
      .then((response) => {
        try {
          if (
            response.webSocket?.readyState === WebSocket.CLOSING ||
            response.webSocket?.readyState === WebSocket.CLOSED
          ) {
            return;
          }
          response.webSocket?.close();
        } catch (err) {
          logError("Error closing WebSocket during cleanup", { err });
        }
      })
      .catch(() => {
        // If the websocket never connected, there's nothing to close; this is fine.
      });
  };

  promise.finally(() => {
    closureFlag = true;
    requestCleanup();
  });
  let count = 0;
  const intervalFinished = new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      count++;
      try {
        logDebug("checking if promise is finished", { count, now: Date.now() });
        const isPromiseFinished = !!closureFlag; // await Promise.race([promise.finally(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1))]);
        if (isPromiseFinished) {
          logDebug("promise is finished, clearing interval", { count, now: Date.now() });
          clearInterval(interval);
          requestCleanup();
          resolve();
          return;
        }
        logDebug("promise is not finished, checking for warning", { count, now: Date.now() });

        // log a warning once if the promise is still running
        if (!loggedWarning && Date.now() > logWarningAt) {
          // do not use debug for this because we want it to surface
          logger.warn(
            `[better-wait-until] has been running for 15 minutes, this usually indicates that you're waiting for a promise that never resolves and better-wait-until is keeping the Durable Object alive, this can incurr significant costs.` +
              `${options.logWarningAfter ? `If this is expected, provide a logWarningAter value to betterWaitUntil to indicate when to log a warning on unresovled promises.` : ""}` +
              `${!options.timeout ? ` You can provide a timeout value to betterWaitUntil that will stop promises from being waited on forever.` : `This promise will terminate at approximately ${options.timeout.toISOString()}`}`,
          );
          loggedWarning = true;
        }

        // log at error level every 10 minutes if the promise is still running
        if (Date.now() > logErrorAt && Date.now() - lastLoggedErrorAt > 1000 * 60 * 10) {
          // do not use debug for this because we want it to surface
          logger.error(
            `[better-wait-until] has been running for 1 hour, this usually indicates that you're waiting for a promise that never resolves and better-wait-until is keeping the Durable Object alive, this can incurr significant costs.` +
              `${options.logErrorAfter ? `If this is expected, provide a logErrorAfter value to betterWaitUntil to indicate when to log an error on unresovled promises.` : ""}` +
              `${!options.timeout ? ` You can provide a timeout value to betterWaitUntil that will stop promises from being waited on forever.` : `This promise will terminate at approximately ${options.timeout.toISOString()}`}`,
          );
          lastLoggedErrorAt = Date.now();
        }

        if (options.timeout && Date.now() > options.timeout.getTime()) {
          // do not use debug for this because we want it to surface
          logger.error(
            "[better-wait-until] Timeout reached, stopping better wait until interval. Your Durable Object may now be killed by Cloudflare and the promise may never resolve.",
          );
          clearInterval(interval);
          requestCleanup();
          resolve();
          return;
        }

        // Cloudflare sometimes gets funky with Date.now outside of a request context so we record the iteration count as well
        logDebug(
          `Background task has been running for ${Date.now() - start}ms (iteration ${count})`,
        );

        const response = await websocketPromise;
        response.webSocket!.send("better-wait-until-ping " + count);
      } catch (err) {
        logError("Error sending better wait until ping", { err });
      }
    }, 10000);
  });

  return intervalFinished;
}

export function betterWaitUntil(
  durableObject: DurableObject,
  promise: Promise<unknown>,
  options: {
    fetchOptions?: Parameters<typeof fetch>[1];
    timeout?: Date;
    logWarningAfter?: Date;
    logErrorAfter?: Date;
  } = {},
): void {
  // Deliberately void the promise - the websocket it creates will keep it alive!
  void betterAwait(durableObject, promise, options);
}
