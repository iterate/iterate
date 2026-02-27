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
  /**
   * Optional request handler provided at construction time.
   * This keeps call sites concise for small tests.
   *
   * Design note:
   * We intentionally keep this primitive and low-level for now:
   * - request -> fetch handler
   * - (future) request upgrade hook
   *
   * Higher-level mocking/recording/blocking APIs can be layered on top
   * without changing the core transport surface.
   */
  fetch?: MockEgressFetch;
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

function safeMatch(matcher: (request: Request) => boolean, request: Request): boolean {
  try {
    return matcher(request);
  } catch {
    return false;
  }
}

export class MockEgressProxy implements AsyncIterable<MockEgressRecord>, AsyncDisposable {
  fetch: MockEgressFetch;

  private readonly recordsInternal: MockEgressRecord[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private readonly broadcaster = new RecordBroadcaster();
  private readonly server = createServer(async (incoming, res) => {
    await this.handleRequest(incoming, res);
  });

  private offset = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private _port = 0;
  private _url = "";
  private _proxyUrl = "";
  private _hostProxyUrl = "";

  private constructor(options?: MockEgressProxyOptions) {
    this.fetch =
      options?.fetch ??
      (async () => new Response("mock-egress-proxy: handler not configured", { status: 501 }));
  }

  static async create(options?: MockEgressProxyOptions): Promise<MockEgressProxy> {
    const proxy = new MockEgressProxy(options);
    await proxy.listen(options?.port);
    return proxy;
  }

  get port() {
    return this._port;
  }

  get url() {
    return this._url;
  }

  get proxyUrl() {
    return this._proxyUrl;
  }

  get hostProxyUrl() {
    return this._hostProxyUrl;
  }

  urlFor(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.url}${normalized}`;
  }

  get records() {
    return this.recordsInternal;
  }

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
          this.settleWaiter(waiter);
          waiter.reject(
            new Error(`mock-egress-proxy waitFor timed out after ${String(waitOptions.timeout)}ms`),
          );
        }, waitOptions.timeout);
      }

      this.waiters.push(waiter);
    });

    const handle = promise as MockEgressWaitForHandle;
    handle.respondWith = (response: Response) => {
      if (!waiterRef || waiterRef.settled) {
        throw new Error("cannot respondWith on a settled waitFor handle");
      }
      waiterRef.interceptResponse = response.clone();
    };
    return handle;
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;

    this.closePromise = new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }

      this.closed = true;
      this.broadcaster.close();
      for (const waiter of [...this.waiters]) {
        if (waiter.settled) continue;
        this.settleWaiter(waiter);
        waiter.reject(new Error("mock-egress-proxy closed before waitFor matched"));
      }
      this.server.close(() => resolve());
    });

    return await this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<MockEgressRecord> {
    return this.broadcaster.subscribe();
  }

  private settleWaiter(waiter: PendingWaiter): void {
    waiter.settled = true;
    if (waiter.timeoutHandle) {
      clearTimeout(waiter.timeoutHandle);
      waiter.timeoutHandle = undefined;
    }
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }

  private async handleRequest(incoming: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = await toRequest(incoming, this.port);
    const requestForRecord = request.clone();
    const createdAt = Date.now();

    const matchedWaiters = this.waiters.filter(
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
        response = await this.fetch(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response = new Response(`mock-egress-proxy handler error: ${message}`, { status: 500 });
      }
    }

    await writeResponse(res, response.clone());

    const record: MockEgressRecord = {
      offset: this.offset,
      request: requestForRecord,
      response: response.clone(),
      createdAt,
      duration: Date.now() - createdAt,
    };
    this.offset += 1;
    this.recordsInternal.push(record);
    this.broadcaster.publish(record);

    for (const waiter of matchedWaiters) {
      if (waiter.settled) continue;
      this.settleWaiter(waiter);
      waiter.resolve(record);
    }
  }

  private async listen(port?: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port ?? 0, "127.0.0.1", () => resolve());
    });

    const address = this.server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("mock-egress-proxy failed to determine listening port");
    }

    this._port = address.port;
    this._url = `http://localhost:${String(this.port)}`;
    this._proxyUrl = `http://host.docker.internal:${String(this.port)}`;
    this._hostProxyUrl = `http://127.0.0.1:${String(this.port)}`;
  }
}

export async function mockEgressProxy(options?: MockEgressProxyOptions): Promise<MockEgressProxy> {
  return await MockEgressProxy.create(options);
}
