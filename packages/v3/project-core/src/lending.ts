// A hibernatable, opaque route from a context DO to a capnweb callback.
//
// The edge owns the capnweb value. The context DO owns only a tagged native
// WebSocket while idle, pages the edge when it needs the value, and borrows a
// native RpcTarget only for active work. That ownership split is what lets a
// context hibernate without retaining a live client capability.

import { RpcTarget } from "cloudflare:workers";
import type { RpcStub } from "capnweb";
import { z } from "zod";
import { Fault } from "./model.ts";

export const LENDING_PAGER_HEADER = "x-project-core-lending-pager";
const PAGER_TAG = "project-core-lending-pager";
const PAGER_ORIGIN = "https://project-core-lending.internal";
const PAGE_TIMEOUT_MS = 10_000;
const CALLBACK_TIMEOUT_MS = 20_000;
const MAX_PAGERS = 64;
const MAX_PATH_SEGMENTS = 16;
const LENDING_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PagerRecord = z.strictObject({ key: z.string().regex(LENDING_KEY) });
const PageFrame = z.strictObject({
  type: z.literal("page"),
  key: z.string().regex(LENDING_KEY),
});

type Page = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The only callable shape lent into a context. An empty path invokes a function callback itself. */
export type LendingInvoker = RpcTarget &
  Disposable & {
    call(path: readonly string[], args: readonly unknown[]): Promise<unknown>;
    dup(): LendingInvoker;
  };

/** The private native DO surface used by the edge relay, never a public capability route. */
export type LendingHost = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  lend(input: { key: string; invoker: LendingInvoker }): Promise<void>;
};

/** A retained capnweb callback stub. `dup()` and `Symbol.dispose` are capnweb's ownership API. */
export type ClientCapability = RpcStub<(...args: never[]) => unknown>;

export type LendingDirectoryState = {
  pagers: number;
  borrowed: number;
  pages: number;
  dormant: boolean;
};

/** DO-side directory. Construct once per DO incarnation and delegate its socket callbacks to it. */
export class LendingDirectory {
  readonly #ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">;
  readonly #onDetached: (key: string) => void;
  readonly #borrowed = new Map<string, LendingInvoker>();
  readonly #pages = new Map<string, Page>();
  readonly #active = new Map<string, number>();
  readonly #releaseWhenIdle = new Set<string>();
  readonly #closed = new WeakSet<WebSocket>();

  constructor(
    ctx: Pick<DurableObjectState, "acceptWebSocket" | "getWebSockets">,
    onDetached: (key: string) => void = () => {},
  ) {
    this.#ctx = ctx;
    this.#onDetached = onDetached;
  }

  /** Handles only the exact private native upgrade; public routing strips this header. */
  attach(request: Request): Response | undefined {
    const key = request.headers.get(LENDING_PAGER_HEADER);
    if (key === null) return undefined;
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.origin !== PAGER_ORIGIN ||
      url.pathname !== "/" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("invalid lending pager upgrade\n", { status: 400 });
    if (!LENDING_KEY.test(key)) return new Response("invalid lending pager key\n", { status: 400 });
    if (this.#pager(key)) return new Response("lending pager already attached\n", { status: 409 });
    if (this.#pagers().length >= MAX_PAGERS)
      return new Response("too many lending pagers\n", { status: 429 });
    const pair = new WebSocketPair();
    this.#ctx.acceptWebSocket(pair[1], [PAGER_TAG]);
    pair[1].serializeAttachment({ key } satisfies z.infer<typeof PagerRecord>);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Edge-only Workers-RPC method. A duplicate page reply cannot replace an extant borrowed leg. */
  lend({ key, invoker }: { key: string; invoker: LendingInvoker }): void {
    if (!LENDING_KEY.test(key) || !this.#pager(key)) {
      invoker[Symbol.dispose]();
      throw new Fault("LENDING_OFFLINE", "Cannot lend to a context without its pager", 409);
    }
    if (this.#borrowed.has(key)) {
      invoker[Symbol.dispose]();
      return;
    }
    // Workers RPC releases an argument stub when this method returns. Retain a
    // native duplicate because the directory owns this leg past that return.
    this.#borrowed.set(key, invoker.dup());
    const page = this.#pages.get(key);
    if (!page) return;
    clearTimeout(page.timer);
    this.#pages.delete(key);
    page.resolve();
  }

  async invoke(key: string, path: readonly string[], args: readonly unknown[]): Promise<unknown> {
    if (!LENDING_KEY.test(key)) throw new Fault("LENDING_OFFLINE", "Invalid lending key", 404);
    const pathSnapshot = Object.freeze([...path]);
    const argsSnapshot = Object.freeze([...args]);
    let invoker = this.#borrowed.get(key);
    if (!invoker && this.#pager(key)) invoker = await this.#page(key);
    if (!invoker) throw new Fault("LENDING_OFFLINE", "Lending target is offline", 404);
    this.#active.set(key, (this.#active.get(key) ?? 0) + 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        invoker.call(pathSnapshot, argsSnapshot),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Fault("LENDING_TIMEOUT", "Lending callback timed out", 504));
          }, CALLBACK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      const active = (this.#active.get(key) ?? 1) - 1;
      if (active) this.#active.set(key, active);
      else {
        this.#active.delete(key);
        if (timedOut || this.#releaseWhenIdle.delete(key)) this.#drop(key);
      }
    }
  }

  /** Call at a context's idle quiesce point. Active work is bounded and disposes on completion. */
  releaseIdle(): void {
    for (const key of this.#borrowed.keys()) {
      if (this.#active.has(key)) this.#releaseWhenIdle.add(key);
      else this.#drop(key);
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const key = this.#pagerKey(ws);
    console.error({
      event: "project-core.lending.protocol",
      key,
      issue: "pager-received-unexpected-frame",
      frame: typeof message === "string" ? message.slice(0, 256) : "binary",
    });
    if (ws.readyState === WebSocket.OPEN) ws.close(1003, "pager is one-way");
  }

  webSocketClose(ws: WebSocket): void {
    const key = this.#pagerKey(ws);
    if (this.#closed.has(ws)) return;
    this.#closed.add(ws);
    if (this.#pager(key)) return; // A newer pager won the reconnect race.
    this.#drop(key);
    this.#failPage(key, new Fault("LENDING_OFFLINE", "Lending pager closed", 404));
    this.#onDetached(key);
  }

  state(): LendingDirectoryState {
    return {
      pagers: this.#pagers().length,
      borrowed: this.#borrowed.size,
      pages: this.#pages.size,
      dormant: this.#borrowed.size === 0 && this.#pages.size === 0,
    };
  }

  async #page(key: string): Promise<LendingInvoker> {
    let page = this.#pages.get(key);
    if (!page) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const timer = setTimeout(
        () => this.#failPage(key, new Fault("LENDING_OFFLINE", "Lending page timed out", 504)),
        PAGE_TIMEOUT_MS,
      );
      page = { promise, resolve, reject, timer };
      this.#pages.set(key, page);
      const pager = this.#pager(key);
      if (!pager) {
        this.#failPage(key, new Fault("LENDING_OFFLINE", "Could not page lending target", 503));
      } else {
        try {
          pager.send(JSON.stringify({ type: "page", key }));
        } catch (error) {
          console.error({ event: "project-core.lending.failure", key, site: "page-send", error });
          this.#failPage(key, new Fault("LENDING_OFFLINE", "Could not page lending target", 503));
        }
      }
    }
    await page.promise;
    const invoker = this.#borrowed.get(key);
    if (!invoker)
      throw new Fault("LENDING_OFFLINE", "Lending page arrived without an invoker", 503);
    return invoker;
  }

  #drop(key: string): void {
    const invoker = this.#borrowed.get(key);
    if (!invoker) return;
    this.#borrowed.delete(key);
    invoker[Symbol.dispose]();
  }

  #failPage(key: string, error: Error): void {
    const page = this.#pages.get(key);
    if (!page) return;
    clearTimeout(page.timer);
    this.#pages.delete(key);
    page.reject(error);
  }

  #pagers(): WebSocket[] {
    return this.#ctx.getWebSockets(PAGER_TAG).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  #pager(key: string): WebSocket | undefined {
    return this.#pagers().find((ws) => this.#pagerKey(ws) === key);
  }

  #pagerKey(ws: WebSocket): string {
    return PagerRecord.parse(ws.deserializeAttachment()).key;
  }
}

class EdgeInvoker extends RpcTarget implements LendingInvoker {
  readonly #target: ClientCapability;
  readonly #broken: { value: boolean };

  constructor(target: ClientCapability, broken: { value: boolean }) {
    super();
    this.#target = target;
    this.#broken = broken;
  }

  [Symbol.dispose](): void {}

  dup(): LendingInvoker {
    return this as unknown as LendingInvoker;
  }

  async call(path: readonly string[], args: readonly unknown[]): Promise<unknown> {
    if (
      path.length > MAX_PATH_SEGMENTS ||
      path.some(
        (part) =>
          !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ||
          ["__proto__", "constructor", "prototype"].includes(part),
      )
    )
      throw new Fault("LENDING_PATH", "Invalid lending callback path");
    try {
      let receiver: unknown;
      let value: unknown = this.#target;
      for (const part of path) {
        receiver = value;
        value = (value as Record<string, unknown>)[part];
      }
      if (typeof value !== "function")
        throw new Fault("LENDING_NOT_CALLABLE", "Callback path is not callable");
      return await Reflect.apply(value, receiver, args);
    } catch (error) {
      if (this.#broken.value)
        throw new Fault("LENDING_OFFLINE", "Lending client disconnected during callback", 503);
      throw error;
    }
  }
}

/** Edge-side owner of a capnweb target. Dispose it at session teardown. */
export async function lend(
  host: LendingHost,
  target: ClientCapability,
  waitUntil: (promise: Promise<unknown>) => void,
  key = crypto.randomUUID(),
): Promise<{ key: string; [Symbol.dispose](): void }> {
  if (!LENDING_KEY.test(key)) throw new Fault("LENDING_KEY", "Lending keys must be UUIDs");
  const retained = target.dup();
  let disposed = false;
  const disposeRetained = () => {
    if (disposed) return;
    disposed = true;
    retained[Symbol.dispose]();
  };
  const broken = { value: false };
  let response: Response;
  try {
    response = await host.fetch(PAGER_ORIGIN, {
      headers: { Upgrade: "websocket", [LENDING_PAGER_HEADER]: key },
    });
  } catch (error) {
    disposeRetained();
    throw error;
  }
  if (response.status !== 101 || !response.webSocket) {
    disposeRetained();
    throw new Fault(
      "LENDING_ATTACH_FAILED",
      `Lending pager upgrade returned ${response.status}`,
      503,
    );
  }
  const pager = response.webSocket;
  pager.accept();
  pager.addEventListener("close", disposeRetained, { once: true });
  retained.onRpcBroken(() => {
    broken.value = true;
    if (pager.readyState === WebSocket.OPEN) pager.close(1000, "capnweb session closed");
    disposeRetained();
  });
  pager.addEventListener("message", (event: MessageEvent) => {
    try {
      const frame = PageFrame.parse(JSON.parse(z.string().parse(event.data)));
      if (frame.key !== key) throw new Fault("LENDING_KEY", "Page belongs to a different pager");
    } catch (error) {
      console.error({
        event: "project-core.lending.protocol",
        key,
        issue: "edge-received-invalid-page",
        error,
      });
      if (pager.readyState === WebSocket.OPEN) pager.close(1003, "invalid pager frame");
      disposeRetained();
      return;
    }
    waitUntil(
      host.lend({ key, invoker: new EdgeInvoker(retained, broken) }).catch((error) => {
        if (broken.value || pager.readyState === WebSocket.CLOSED) {
          console.info({
            event: "project-core.lending.normal",
            key,
            outcome: "pager-closed-before-lend",
          });
          return;
        }
        console.error({ event: "project-core.lending.failure", key, site: "edge-lend", error });
      }),
    );
  });
  return {
    key,
    [Symbol.dispose]: () => {
      if (pager.readyState === WebSocket.OPEN) pager.close(1000, "lending disposed");
      disposeRetained();
    },
  };
}
