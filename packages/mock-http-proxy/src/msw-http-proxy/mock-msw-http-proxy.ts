import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createNativeMswServer, type NativeMswServer } from "@iterate-com/msw-http-server";
import type { RequestHandler } from "msw";
import type { Har } from "har-format";
import { HarJournal } from "./har-journal.ts";
import { createHarReplayHandler } from "./har-replay-handler.ts";
import { createPassthroughRecordHandler } from "./passthrough-record-handler.ts";
import type {
  MockMswHttpProxyListenOptions,
  MockMswHttpProxyMode,
  MockMswHttpProxyRequestRewrite,
} from "./types.ts";

function fallbackHandlers(options: {
  mode: MockMswHttpProxyMode;
  harJournal: HarJournal;
  rewriteRequest?: MockMswHttpProxyRequestRewrite;
}): RequestHandler[] {
  const handlers: RequestHandler[] = [];

  if (options.mode === "replay" || options.mode === "replay-or-record") {
    handlers.push(
      createHarReplayHandler({
        harJournal: options.harJournal,
        rewriteRequest: options.rewriteRequest,
      }),
    );
  }

  if (options.mode === "record" || options.mode === "replay-or-record") {
    handlers.push(
      createPassthroughRecordHandler({
        harJournal: options.harJournal,
        rewriteRequest: options.rewriteRequest,
      }),
    );
  }

  return handlers;
}

function tcpAddress(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock-msw-http-proxy failed to bind to a TCP port");
  }

  return address;
}

export class MockMswHttpProxy implements AsyncDisposable {
  private server: NativeMswServer | undefined;
  private closePromise: Promise<void> | undefined;
  private started = false;
  private harJournal = new HarJournal();
  private harRecordingPath = "";

  public port = 0;
  public url = "";

  static async start(options: MockMswHttpProxyListenOptions): Promise<MockMswHttpProxy> {
    const proxy = new MockMswHttpProxy();
    await proxy.listen(options);
    return proxy;
  }

  async listen(options: MockMswHttpProxyListenOptions): Promise<void> {
    if (this.started) {
      throw new Error("MockMswHttpProxy.listen() called more than once");
    }
    this.started = true;

    const mode = options.mode ?? "record";
    if (mode === "replay" && !options.replayFromHar) {
      throw new Error('MockMswHttpProxy in mode="replay" requires replayFromHar');
    }

    this.harRecordingPath = options.harRecordingPath ?? "";
    this.harJournal = await HarJournal.fromSource(options.replayFromHar);

    const handlers = [
      ...(options.handlers ?? []),
      ...fallbackHandlers({
        mode,
        harJournal: this.harJournal,
        rewriteRequest: options.rewriteRequest,
      }),
    ];

    this.server = createNativeMswServer(
      {
        onUnhandledRequest: options.onUnhandledRequest ?? "bypass",
      },
      ...handlers,
    );

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
    });

    const address = tcpAddress(this.server);
    const host = options.host ?? "127.0.0.1";
    this.port = address.port;
    this.url = `http://${host}:${String(this.port)}`;
  }

  private requireServer(): NativeMswServer {
    if (!this.server) {
      throw new Error("MockMswHttpProxy server is not running");
    }

    return this.server;
  }

  use(...handlers: RequestHandler[]): void {
    this.requireServer().use(...handlers);
  }

  resetHandlers(...nextHandlers: RequestHandler[]): void {
    this.requireServer().resetHandlers(...nextHandlers);
  }

  restoreHandlers(): void {
    this.requireServer().restoreHandlers();
  }

  listHandlers() {
    return this.requireServer().listHandlers();
  }

  get events() {
    return this.requireServer().events;
  }

  getHar(): Har {
    return this.harJournal.getHar();
  }

  async writeHar(path = this.harRecordingPath): Promise<void> {
    if (!path) {
      throw new Error("harRecordingPath is not configured");
    }

    await this.harJournal.write(path);
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;

    this.closePromise = (async () => {
      if (!this.server) return;

      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });

      if (this.harRecordingPath) {
        await this.harJournal.write(this.harRecordingPath);
      }
    })();

    await this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
