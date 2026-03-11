import EventEmitter from "node:events";
import * as OpenCode from "@opencode-ai/sdk/v2";
import * as config from "./config.ts";

type OpencodeEventMap = {
  [E in OpenCode.GlobalEvent["payload"]["type"]]: [
    event: { directory: string; payload: Extract<OpenCode.GlobalEvent["payload"], { type: E }> },
  ];
};

export type OpencodeEventEmitter = EventEmitter<OpencodeEventMap>;

type EventStreamFailure = {
  attempts: number;
  error?: unknown;
};

type EventEmitterOptions = {
  maxAttempts?: number;
  onMaxAttempts?: (info: EventStreamFailure) => void | Promise<void>;
};

export function opencodeEventEmitter(
  opencodeClient: OpenCode.OpencodeClient,
  options: EventEmitterOptions = {},
) {
  const eventEmitter = new EventEmitter<OpencodeEventMap>();
  const backoff = {
    baseMs: 500,
    maxMs: 30000,
  };
  const maxAttempts = options.maxAttempts ?? 50;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  void (async () => {
    let attempt = 0;
    let notified = false;
    let lastError: unknown;
    while (true) {
      try {
        const events = await opencodeClient.global.event();
        attempt = 0;
        notified = false;
        lastError = undefined;
        for await (const event of events.stream) {
          // @ts-expect-error - doesn't need to be typed
          eventEmitter.emit(event.payload.type, event);
        }
      } catch (error) {
        lastError = error;
        console.error("[opencode] event stream error", error);
      }

      attempt += 1;
      if (attempt >= maxAttempts && !notified) {
        notified = true;
        await options.onMaxAttempts?.({ attempts: attempt, error: lastError });
        return;
      }

      const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * backoff.baseMs);
      await sleep(exp + jitter);
    }
  })();

  return eventEmitter;
}

export class OpencodeService {
  public readonly client: OpenCode.OpencodeClient;
  public readonly events: OpencodeEventEmitter;

  constructor() {
    this.client = OpenCode.createOpencodeClient({
      baseUrl: config.OPENCODE_BASE_URL,
      directory: config.INITIAL_CWD,
    });
    this.events = opencodeEventEmitter(this.client, {
      maxAttempts: 50,
      onMaxAttempts: (info) =>
        console.error(
          "[opencode] Max attempts reached while trying to connect to event stream",
          info,
        ),
    });
  }
}
