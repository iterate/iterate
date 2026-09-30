// e2e/support/not-routed.ts — A REQUEST CLOUDFLARE ANSWERED ITSELF IS SENT AGAIN. A per-commit
// deployment's workers.dev hostname is brand-new, and it reaches Cloudflare's servers one by one: for
// up to about a minute after its deploy (measured 2026-09-28), a connection can land on a server that
// has not learned it and answers Cloudflare's own not-found (@iterate-com/shared/platform-retry
// `isNotRoutedYet`). The readiness gate (scripts/os/preview-readiness.ts) samples connections, so it
// cannot rule such a server out. The request never reached the Worker, so the process's one
// transport, undici's global dispatcher (Node's fetch and WebSocket and undici's own go through it),
// sends it again, whatever its method, on a fresh connection of its own, which lands on another
// server, and drops the connection the answer came on. A resend waits CI_HTTP's schedule and logs
// `e2e.platform-failure-retry` with the answer's cf-ray (its colo); once the schedule is spent it
// logs `e2e.platform-failure-gave-up` and the request fails, naming the answer. Every other answer,
// the Worker's own 404 included, passes through as it came.
import { Client, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import {
  CI_HTTP,
  isNotRoutedYet,
  jitteredMs,
  logPlatformFailure,
  type Schedule,
} from "@iterate-com/shared/platform-retry";

/** Marks the global dispatcher once it resends, so the setup file, run for every test file in the
 *  same process, composes it once. */
const INSTALLED = Symbol.for("iterate.e2e.resends-not-routed-yet");

/** Send this process's requests again when Cloudflare answers them itself (support/setup.ts). */
export function resendNotRoutedYetInThisProcess(): void {
  const current: Dispatcher & { [INSTALLED]?: true } = getGlobalDispatcher();
  if (current[INSTALLED]) return;
  setGlobalDispatcher(Object.assign(current.compose(resendNotRoutedYet()), { [INSTALLED]: true }));
}

/** The interceptor. `pause` waits between attempts (a test injects its clock); `connect` makes the
 *  fresh connection a resend goes on: one HTTP/1.1 connection of its own, closed once its answer
 *  has come (an upgraded socket leaves it at once). */
export function resendNotRoutedYet(
  options: {
    schedule?: Schedule;
    pause?: (ms: number) => Promise<void>;
    connect?: (origin: string) => Dispatcher;
  } = {},
): Dispatcher.DispatcherComposeInterceptor {
  const {
    schedule = CI_HTTP,
    pause = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    connect = (origin) => new Client(origin, { allowH2: false }),
  } = options;
  return (dispatch) => (opts, handler) => {
    void send({ dispatch, opts, downstream: handler, schedule, pause, connect });
    return true;
  };
}

/** One request through every attempt it takes. The first goes the way it would have; each resend
 *  on its own connection. `downstream` (fetch, a WebSocket, undici's request) sees one attempt: the
 *  first whose answer is not Cloudflare's not-found, or the error that ends the schedule. */
async function send(input: {
  dispatch: Dispatcher.Dispatch;
  opts: Dispatcher.DispatchOptions;
  downstream: Dispatcher.DispatchHandler;
  schedule: Schedule;
  pause: (ms: number) => Promise<void>;
  connect: (origin: string) => Dispatcher;
}) {
  const { opts, downstream, schedule } = input;
  // the Agent's dispatch names every request's origin
  const origin = String(opts.origin);
  // no query string: a signed URL's carries its signature
  const url = new URL(opts.path, origin);
  const request = `${opts.method} ${url.origin}${url.pathname}`;
  const controller = new DownstreamController();
  let started = false;
  const body = await resendableBody(opts.body).catch((error: unknown) => error as Error);
  if (body instanceof Error) {
    downstream.onResponseError?.(controller, body);
    return;
  }
  const attemptOpts = { ...opts, body: body.body };
  for (let attempt = 1; ; attempt++) {
    const answer = await new Promise<NotRoutedYet | undefined>((settled) => {
      const handler = attemptHandler({
        downstream,
        controller,
        resendable: body.resendable,
        start: (context) => {
          if (started) return;
          started = true;
          downstream.onRequestStart?.(controller, context);
        },
        settled,
      });
      try {
        if (attempt === 1) input.dispatch(attemptOpts, handler);
        else {
          const connection = input.connect(origin);
          connection.dispatch(attemptOpts, handler);
          void connection.close();
        }
      } catch (error) {
        handler.onResponseError?.(controller, error as Error);
      }
    });
    if (!answer) return;
    const delayMs = schedule.delaysMs[attempt - 1];
    const fields = { request, answer: answer.message, ray: answer.ray };
    if (delayMs === undefined) {
      logPlatformFailure("e2e", "gave-up", "disconnected", { ...fields, attempts: attempt });
      downstream.onResponseError?.(
        controller,
        new Error(
          `${request}: Cloudflare answered ${answer.message} on ${attempt} connections: the servers they reached do not route ${url.host} yet`,
        ),
      );
      return;
    }
    const retryInMs = jitteredMs(delayMs);
    logPlatformFailure("e2e", "retry", "disconnected", { ...fields, attempt, retryInMs });
    await Promise.race([input.pause(retryInMs), controller.abortion]);
    if (controller.aborted) {
      downstream.onResponseError?.(controller, controller.reason!);
      return;
    }
  }
}

/** Cloudflare's own not-found, as one attempt met it. */
type NotRoutedYet = { message: string; ray: string | undefined };

/** The handler of one attempt. Until its answer is known to be the Worker's it passes nothing on
 *  but the start of the request (once); then everything, as it comes. It settles with the
 *  not-found Cloudflare answered, or with nothing once `downstream` has had the answer, an upgrade
 *  or an error. The page is known by its header, a plain answer of a few bytes once its last byte
 *  is read; either is then abandoned. Over HTTP/1.1 that drops the connection it came on, so no
 *  later request of the pool goes to that server; over HTTP/2 it resets the stream, and a later
 *  request on the session that meets the server again is sent again the same way. */
function attemptHandler(input: {
  downstream: Dispatcher.DispatchHandler;
  controller: DownstreamController;
  resendable: boolean;
  start: (context: unknown) => void;
  settled: (answer: NotRoutedYet | undefined) => void;
}): Dispatcher.DispatchHandler {
  const { downstream, controller, settled } = input;
  let state: "waiting" | "passing" | "reading" | "not-routed" = "waiting";
  let notRouted: NotRoutedYet | undefined;
  let head:
    | { status: number; headers: Record<string, string | string[] | undefined>; length: number }
    | undefined;
  let statusMessage: string | undefined;
  const chunks: Buffer[] = [];
  const pass = () => {
    state = "passing";
    settled(undefined);
  };
  /** Cloudflare answered: the attempt is aborted, which drops its connection, and settles with it. */
  const abandon = (
    attempt: Dispatcher.DispatchController,
    message: string,
    headers: Record<string, string | string[] | undefined>,
  ) => {
    state = "not-routed";
    const ray = headers["cf-ray"];
    notRouted = { message, ray: typeof ray === "string" ? ray : undefined };
    attempt.abort(new Error(`Cloudflare's own not-found: ${message}`));
  };
  return {
    onRequestStart(attempt, context) {
      controller.target = attempt;
      if (controller.aborted) return attempt.abort(controller.reason!);
      input.start(context);
    },
    onRequestUpgrade(_attempt, statusCode, headers, socket) {
      // Over HTTP/2 a refused WebSocket upgrade arrives here with its status (RFC 8441), and undici
      // wants the verdict before this returns: known by the page's header alone, its stream closed.
      if (input.resendable && isNotRoutedYet({ status: statusCode, headers })) {
        state = "not-routed";
        const ray = headers["cf-ray"];
        socket.destroy();
        return settled({
          message: `${statusCode} x-preview-user-error`,
          ray: typeof ray === "string" ? ray : undefined,
        });
      }
      pass();
      downstream.onRequestUpgrade?.(controller, statusCode, headers, socket);
    },
    onResponseStarted() {
      downstream.onResponseStarted?.();
    },
    onResponseStart(attempt, statusCode, headers, message) {
      if (input.resendable && isNotRoutedYet({ status: statusCode, headers }))
        return abandon(attempt, `${statusCode} x-preview-user-error`, headers);
      const length = plainNotRoutedYetLength(statusCode, headers);
      if (input.resendable && length) {
        state = "reading";
        head = { status: statusCode, headers, length };
        statusMessage = message;
        return;
      }
      pass();
      downstream.onResponseStart?.(controller, statusCode, headers, message);
    },
    onResponseData(attempt, chunk) {
      if (state === "passing") return downstream.onResponseData?.(controller, chunk);
      if (state !== "reading") return;
      chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length < head!.length) return;
      if (body.length === head!.length && isNotRoutedYet({ ...head!, body: body.toString("utf8") }))
        return abandon(attempt, `${head!.status} ${body.toString("utf8").trim()}`, head!.headers);
      pass();
      downstream.onResponseStart?.(controller, head!.status, head!.headers, statusMessage);
      for (const read of chunks.splice(0)) downstream.onResponseData?.(controller, read);
    },
    onResponseEnd(_attempt, trailers) {
      if (state === "passing") downstream.onResponseEnd?.(controller, trailers);
    },
    onResponseError(_attempt, error) {
      if (state === "not-routed" && !controller.aborted) return settled(notRouted);
      if (state !== "passing") pass();
      downstream.onResponseError?.(controller, error);
    },
    onBodySent(chunk) {
      downstream.onBodySent?.(chunk);
    },
    onRequestSent() {
      downstream.onRequestSent?.();
    },
  };
}

/** Cloudflare's plain codes are 16 bytes and a line end. */
const PLAIN_NOT_ROUTED_MAX_BYTES = 32;

/** A 404 or 500 of a few bytes of plain text could be `error code: 1042` or `1104`: its length, when
 *  it is read before it is passed on, else 0. Cloudflare sends those with a `content-length`. */
function plainNotRoutedYetLength(
  status: number,
  headers: Record<string, string | string[] | undefined>,
) {
  const type = headers["content-type"];
  const length = Number(headers["content-length"]);
  const plain =
    (status === 404 || status === 500) &&
    typeof type === "string" &&
    type.startsWith("text/plain") &&
    Number.isInteger(length) &&
    length > 0 &&
    length <= PLAIN_NOT_ROUTED_MAX_BYTES;
  return plain ? length : 0;
}

/** The controller `downstream` holds for the whole request: it acts on the attempt in flight, and
 *  an abort between attempts ends the wait. */
class DownstreamController implements Dispatcher.DispatchController {
  target: Dispatcher.DispatchController | undefined;
  #reason: Error | null = null;
  #aborted = Promise.withResolvers<void>();
  /** Resolves once `abort` is called. */
  readonly abortion = this.#aborted.promise;
  get aborted() {
    return this.#reason !== null;
  }
  get paused() {
    return this.target?.paused ?? false;
  }
  get reason() {
    return this.#reason;
  }
  get rawHeaders() {
    return this.target?.rawHeaders;
  }
  get rawTrailers() {
    return this.target?.rawTrailers;
  }
  abort(reason: Error) {
    if (this.#reason) return;
    this.#reason = reason;
    this.target?.abort(reason);
    this.#aborted.resolve();
  }
  pause() {
    this.target?.pause();
  }
  resume() {
    this.target?.resume();
  }
}

/** A request body every attempt can send. Fetch hands its body over as an async iterable, read as
 *  it is sent, so it is read once, here, into bytes. A body undici reads itself (FormData) goes
 *  once: its answer passes through whatever it is. */
async function resendableBody(body: Dispatcher.DispatchOptions["body"]) {
  if (!body || typeof body === "string" || body instanceof Uint8Array)
    return { body, resendable: true };
  if (!(Symbol.asyncIterator in body)) return { body, resendable: false };
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return { body: Buffer.concat(chunks), resendable: true };
}
