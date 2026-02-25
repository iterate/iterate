import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Why this helper exists:
 * - MSW has an excellent API and team, but it patches global `fetch`, which is
 *   awkward for concurrent integration tests running in one process.
 * - `mockttp` works, but its API is heavier than we want for crisp e2e fixtures.
 *
 * This proxy is a small real HTTP server with a per-instance `fetch` handler.
 */
export type MockEgressFetch = (request: Request) => Response | Promise<Response>;

export interface MockEgressRecord {
  offset: number;
  request: Request;
  response: Response;
  createdAt: number;
  duration: number;
}

export interface MockEgressWaitForHandle extends Promise<MockEgressRecord> {
  respondWith(response: Response): void;
}

export interface MockEgressProxyOptions {
  port?: number;
}

export interface MockEgressProxy extends AsyncIterable<MockEgressRecord>, AsyncDisposable {
  fetch: MockEgressFetch;
  readonly port: number;
  readonly url: string;
  readonly proxyUrl: string;
  readonly hostProxyUrl: string;
  urlFor(path: string): string;
  readonly records: ReadonlyArray<MockEgressRecord>;
  waitFor(
    matcher: (request: Request) => boolean,
    options?: { timeout?: number },
  ): MockEgressWaitForHandle;
  close(): Promise<void>;
}

type PendingWaiter = {
  matcher: (request: Request) => boolean;
  resolve: (record: MockEgressRecord) => void;
  reject: (error: Error) => void;
  timeoutHandle?: NodeJS.Timeout;
  interceptResponse?: Response;
  settled: boolean;
};

class RecordBroadcaster {
  private readonly subscribers = new Set<{
    queue: MockEgressRecord[];
    resolve?: () => void;
    done: boolean;
  }>();

  publish(record: MockEgressRecord): void {
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(record);
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
  }

  subscribe(): AsyncIterableIterator<MockEgressRecord> {
    const subscriber = {
      queue: [] as MockEgressRecord[],
      resolve: undefined as (() => void) | undefined,
      done: false,
    };
    this.subscribers.add(subscriber);

    const iterator: AsyncIterableIterator<MockEgressRecord> = {
      next: async () => {
        while (subscriber.queue.length === 0 && !subscriber.done) {
          await new Promise<void>((resolve) => {
            subscriber.resolve = resolve;
          });
        }
        if (subscriber.queue.length > 0) {
          return { value: subscriber.queue.shift()!, done: false };
        }
        return { value: undefined, done: true };
      },
      return: async () => {
        subscriber.done = true;
        this.subscribers.delete(subscriber);
        subscriber.resolve?.();
        subscriber.resolve = undefined;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };

    return iterator;
  }

  close(): void {
    for (const subscriber of this.subscribers) {
      subscriber.done = true;
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
    this.subscribers.clear();
  }
}

async function toRequest(incoming: IncomingMessage, port: number): Promise<Request> {
  const url = new URL(incoming.url ?? "/", `http://localhost:${String(port)}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  const method = incoming.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  if (!hasBody) {
    return new Request(url, { method, headers });
  }

  const bodyChunks: Buffer[] = [];
  for await (const chunk of incoming) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Request(url, {
    method,
    headers,
    body: Buffer.concat(bodyChunks),
  });
}

async function writeResponse(res: ServerResponse, webResponse: Response): Promise<void> {
  res.statusCode = webResponse.status;
  for (const [key, value] of webResponse.headers.entries()) {
    res.setHeader(key, value);
  }

  if (webResponse.body === null) {
    res.end();
    return;
  }

  const body = Buffer.from(await webResponse.arrayBuffer());
  res.end(body);
}

function settleWaiter(waiters: PendingWaiter[], waiter: PendingWaiter): void {
  waiter.settled = true;
  if (waiter.timeoutHandle) {
    clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = undefined;
  }
  const index = waiters.indexOf(waiter);
  if (index >= 0) {
    waiters.splice(index, 1);
  }
}

function safeMatch(matcher: (request: Request) => boolean, request: Request): boolean {
  try {
    return matcher(request);
  } catch {
    return false;
  }
}

export async function mockEgressProxy(options?: MockEgressProxyOptions): Promise<MockEgressProxy> {
  const records: MockEgressRecord[] = [];
  const waiters: PendingWaiter[] = [];
  const broadcaster = new RecordBroadcaster();
  let offset = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let port = 0;
  let url = "";
  let proxyUrl = "";
  let hostProxyUrl = "";

  const proxy: MockEgressProxy = {
    fetch: async () => new Response("mock-egress-proxy: handler not configured", { status: 501 }),
    get port() {
      return port;
    },
    get url() {
      return url;
    },
    get proxyUrl() {
      return proxyUrl;
    },
    get hostProxyUrl() {
      return hostProxyUrl;
    },
    urlFor(path: string): string {
      const normalized = path.startsWith("/") ? path : `/${path}`;
      return `${url}${normalized}`;
    },
    get records() {
      return records;
    },
    waitFor(
      matcher: (request: Request) => boolean,
      waitOptions?: { timeout?: number },
    ): MockEgressWaitForHandle {
      let waiterRef: PendingWaiter | undefined;
      const promise = new Promise<MockEgressRecord>((resolve, reject) => {
        const waiter: PendingWaiter = {
          matcher,
          resolve,
          reject,
          settled: false,
        };
        waiterRef = waiter;

        if (waitOptions?.timeout !== undefined) {
          waiter.timeoutHandle = setTimeout(() => {
            if (waiter.settled) return;
            settleWaiter(waiters, waiter);
            waiter.reject(
              new Error(
                `mock-egress-proxy waitFor timed out after ${String(waitOptions.timeout)}ms`,
              ),
            );
          }, waitOptions.timeout);
        }

        waiters.push(waiter);
      });

      const handle = promise as MockEgressWaitForHandle;
      handle.respondWith = (response: Response) => {
        if (!waiterRef || waiterRef.settled) {
          throw new Error("cannot respondWith on a settled waitFor handle");
        }
        waiterRef.interceptResponse = response.clone();
      };
      return handle;
    },
    async close(): Promise<void> {
      if (closePromise) return await closePromise;
      closePromise = new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        broadcaster.close();
        for (const waiter of [...waiters]) {
          if (waiter.settled) continue;
          settleWaiter(waiters, waiter);
          waiter.reject(new Error("mock-egress-proxy closed before waitFor matched"));
        }
        server.close(() => resolve());
      });
      return await closePromise;
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await proxy.close();
    },
    [Symbol.asyncIterator](): AsyncIterator<MockEgressRecord> {
      return broadcaster.subscribe();
    },
  };

  const server = createServer(async (incoming, res) => {
    const request = await toRequest(incoming, port);
    const requestForRecord = request.clone();
    const createdAt = Date.now();

    const matchedWaiters = waiters.filter(
      (waiter) => !waiter.settled && safeMatch(waiter.matcher, requestForRecord.clone()),
    );
    const interceptingWaiter = matchedWaiters.find(
      (waiter) => waiter.interceptResponse !== undefined,
    );

    let response: Response;
    if (interceptingWaiter?.interceptResponse) {
      response = interceptingWaiter.interceptResponse.clone();
      interceptingWaiter.interceptResponse = undefined;
    } else {
      try {
        response = await proxy.fetch(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = new Response(`mock-egress-proxy handler error: ${message}`, { status: 500 });
      }
    }

    await writeResponse(res, response.clone());

    const record: MockEgressRecord = {
      offset,
      request: requestForRecord,
      response: response.clone(),
      createdAt,
      duration: Date.now() - createdAt,
    };
    offset += 1;
    records.push(record);
    broadcaster.publish(record);

    for (const waiter of matchedWaiters) {
      if (waiter.settled) continue;
      settleWaiter(waiters, waiter);
      waiter.resolve(record);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options?.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await proxy.close();
    throw new Error("mock-egress-proxy failed to determine listening port");
  }

  port = address.port;
  url = `http://localhost:${String(port)}`;
  proxyUrl = `http://host.docker.internal:${String(port)}`;
  hostProxyUrl = `http://127.0.0.1:${String(port)}`;

  return proxy;
}
