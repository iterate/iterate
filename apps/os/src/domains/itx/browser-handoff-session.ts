import puppeteer, {
  type Browser,
  type CDPSession,
  type HandoffCompleteResponse,
  type HandoffResponse,
  type Page,
} from "@cloudflare/puppeteer";
import { z } from "zod";
import type {
  CfBrowserHandoffInput,
  CfBrowserHandoffResult,
  CfBrowserHandoffStarted,
  CfBrowserOpenInput,
  CfBrowserPageInfo,
  CfBrowserTextInput,
} from "./cf-capabilities.ts";

const DEFAULT_HANDOFF_TIMEOUT_MS = 5 * 60_000;
const BROWSER_KEEP_ALIVE_MS = 10 * 60_000;
const HANDOFF_COMPLETION_GRACE_MS = 5_000;
// Browser Run's keep_alive is an inactivity timeout reset by commands. Leave
// enough idle headroom for our completion watchdog to classify a missing event
// before Browser Run disconnects the session.
const HANDOFF_IDLE_HEADROOM_MS = 55_000;
const MAX_HANDOFF_TIMEOUT_MS =
  BROWSER_KEEP_ALIVE_MS - HANDOFF_COMPLETION_GRACE_MS - HANDOFF_IDLE_HEADROOM_MS;
const DEFAULT_TEXT_CHARACTERS = 20_000;
const MAX_TEXT_CHARACTERS = 100_000;
const HandoffComplete = z.object({
  handoffId: z.string().optional(),
  instructions: z.string().optional(),
  reason: z.string().optional(),
  success: z.boolean(),
  targetId: z.string(),
});

type PendingHandoff = {
  completion: Promise<HandoffCompletion>;
  handoffId: string | undefined;
  listener: (event: unknown) => void;
  outcome: HandoffCompletion | undefined;
  protocolAnomaly: CfBrowserHandoffResult["protocolAnomaly"];
  resolve: (outcome: HandoffCompletion) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
  waiting: boolean;
};

type HandoffCompletion =
  | { event: HandoffCompleteResponse; status: "completed" }
  | { error: Error; status: "failed" };

/**
 * Owns one stateful Browser Run page while an agent alternates between
 * automation and an explicit human handoff. The public RPC target wraps this
 * controller so its lifecycle can be tested without a live Browser binding.
 */
export class BrowserHandoffSession {
  readonly #browser: Browser;
  readonly #cdp: CDPSession;
  readonly #page: Page;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #handoffStarting = false;
  #pendingHandoff: PendingHandoff | undefined;

  constructor(args: { browser: Browser; cdp: CDPSession; page: Page }) {
    this.#browser = args.browser;
    this.#cdp = args.cdp;
    this.#page = args.page;
    this.#browser.on("disconnected", this.#handleBrowserDisconnected);
  }

  async text(input: CfBrowserTextInput = {}): Promise<string> {
    this.#assertOpen();
    const maxCharacters = input.maxCharacters ?? DEFAULT_TEXT_CHARACTERS;
    if (
      !Number.isInteger(maxCharacters) ||
      maxCharacters < 1 ||
      maxCharacters > MAX_TEXT_CHARACTERS
    ) {
      throw new Error(
        `Browser session text maxCharacters must be an integer from 1 to ${MAX_TEXT_CHARACTERS}.`,
      );
    }
    const text = await this.#page.evaluate(() => document.body?.innerText ?? "");
    return text.slice(0, maxCharacters);
  }

  async startHandoff(input: CfBrowserHandoffInput): Promise<CfBrowserHandoffStarted> {
    this.#assertOpen();
    if (this.#handoffStarting || this.#pendingHandoff !== undefined) {
      throw new Error(
        "Browser session already has a handoff starting, active, or awaiting result consumption.",
      );
    }
    const instructions = input.instructions.trim();
    if (instructions.length === 0 || instructions.length > 4_096) {
      throw new Error("Browser handoff instructions must contain 1 to 4096 characters.");
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_HANDOFF_TIMEOUT_MS) {
      throw new Error(
        `Browser handoff timeoutMs must be an integer from 1 to ${MAX_HANDOFF_TIMEOUT_MS}.`,
      );
    }

    this.#handoffStarting = true;
    try {
      const state = await this.#cdp.send("Cloudflare.getHandoffState");
      if (state.active) {
        throw new Error(
          `Browser Run reports an active handoff${state.handoffId ? ` (${state.handoffId})` : ""}; complete it before starting another.`,
        );
      }

      const liveViewRequestedAt = Date.now();
      const liveView = await this.#cdp.send("Cloudflare.getLiveView", {
        expiresInMs: timeoutMs,
        mode: "tab",
      });
      const expiresAt = liveViewRequestedAt + timeoutMs;
      const completion = Promise.withResolvers<HandoffCompletion>();
      const pending: PendingHandoff = {
        completion: completion.promise,
        handoffId: undefined,
        listener: (event) => {
          const result = HandoffComplete.safeParse(event);
          this.#settlePendingHandoff(
            pending,
            result.success
              ? { event: result.data, status: "completed" }
              : {
                  error: new Error(
                    `Browser Run returned an invalid handoff completion: ${result.error}`,
                  ),
                  status: "failed",
                },
          );
        },
        outcome: undefined,
        protocolAnomaly: undefined,
        resolve: completion.resolve,
        timeoutId: undefined,
        waiting: false,
      };
      this.#pendingHandoff = pending;

      // Register before Cloudflare.handoff so an immediate human completion
      // cannot race past the waiter.
      this.#cdp.once("Cloudflare.handoffComplete", pending.listener);
      pending.timeoutId = setTimeout(() => {
        this.#failPendingHandoff(
          new Error(
            `Browser Run did not emit handoffComplete within ${timeoutMs + HANDOFF_COMPLETION_GRACE_MS}ms.`,
          ),
        );
      }, timeoutMs + HANDOFF_COMPLETION_GRACE_MS);
      let handoff: HandoffResponse;
      try {
        handoff = await this.#cdp.send("Cloudflare.handoff", {
          instructions,
          timeout: timeoutMs,
        });
      } catch (error) {
        const startError =
          error instanceof Error ? error : new Error("Browser Run handoff failed to start.");
        if (pending.outcome?.status === "completed") {
          // The explicit completion is the stronger fact, but a rejected
          // start acknowledgement is still a protocol anomaly agents and
          // operators must be able to classify.
          pending.handoffId = pending.outcome.event.handoffId ?? crypto.randomUUID();
          pending.protocolAnomaly = "start-command-rejected-after-completion";
          console.error("Browser Run handoff command rejected after completion", {
            error: startError,
            handoffId: pending.handoffId,
          });
          return {
            expiresAt,
            handoffId: pending.handoffId,
            liveViewUrl: liveView.devtoolsFrontendUrl,
          };
        }
        if (pending.outcome?.status === "failed") {
          console.error("Browser Run handoff command rejected after invalid completion", {
            completionError: pending.outcome.error,
            startError,
          });
          this.#pendingHandoff = undefined;
          throw pending.outcome.error;
        }
        this.#failPendingHandoff(startError);
        this.#pendingHandoff = undefined;
        throw startError;
      }
      if (pending.outcome?.status === "failed") {
        this.#pendingHandoff = undefined;
        throw pending.outcome.error;
      }
      pending.handoffId = handoff.handoffId;
      return {
        expiresAt,
        handoffId: handoff.handoffId,
        liveViewUrl: liveView.devtoolsFrontendUrl,
      };
    } finally {
      this.#handoffStarting = false;
    }
  }

  async waitForHandoff(handoffId: string): Promise<CfBrowserHandoffResult> {
    const pending = this.#pendingHandoff;
    if (pending?.handoffId !== handoffId) {
      throw new Error(`Browser session has no handoff awaiting result for ${handoffId}.`);
    }
    if (pending.waiting) {
      throw new Error(`Browser handoff ${handoffId} already has a waiter.`);
    }
    pending.waiting = true;
    try {
      const completion = await pending.completion;
      if (completion.status === "failed") throw completion.error;
      const result = completion.event;
      if (result.handoffId !== undefined && result.handoffId !== handoffId) {
        throw new Error(
          `Browser Run completed unexpected handoff ${result.handoffId}; expected ${handoffId}.`,
        );
      }
      return {
        handoffId,
        page: await this.#pageInfoIfConnected(),
        protocolAnomaly: pending.protocolAnomaly,
        reason: result.reason,
        sessionActive: !this.#closed,
        success: result.success,
        targetId: result.targetId,
      };
    } finally {
      if (this.#pendingHandoff === pending) this.#pendingHandoff = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return await this.#closePromise;
    this.#closed = true;
    this.#browser.off("disconnected", this.#handleBrowserDisconnected);
    this.#failPendingHandoff(new Error("Browser session closed during human handoff."));
    this.#closePromise = this.#browser.close();
    return await this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Browser session is closed.");
  }

  async #pageInfoIfConnected(): Promise<CfBrowserPageInfo | undefined> {
    if (this.#closed) return undefined;
    try {
      return {
        title: await this.#page.title(),
        url: this.#page.url(),
      };
    } catch (error) {
      // Preserve the already-explicit human result when a disconnect races
      // page inspection. Other page errors remain infrastructure failures.
      if (this.#closed) return undefined;
      throw error;
    }
  }

  #failPendingHandoff(error: Error): void {
    const pending = this.#pendingHandoff;
    if (pending === undefined) return;
    this.#settlePendingHandoff(pending, { error, status: "failed" });
  }

  #settlePendingHandoff(pending: PendingHandoff, outcome: HandoffCompletion): void {
    if (pending.outcome !== undefined) return;
    clearTimeout(pending.timeoutId);
    this.#cdp.off("Cloudflare.handoffComplete", pending.listener);
    pending.outcome = outcome;
    pending.resolve(outcome);
  }

  readonly #handleBrowserDisconnected = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#closePromise = Promise.resolve();
    this.#failPendingHandoff(new Error("Browser Run disconnected during human handoff."));
  };
}

/** Launch and navigate a stateful Browser Run session with bounded lifetime. */
export async function openBrowserHandoffSession(
  binding: BrowserRun,
  input: CfBrowserOpenInput,
): Promise<BrowserHandoffSession> {
  assertBrowserUrl(input.url);
  const browser = await puppeteer.launch(binding, {
    keep_alive: BROWSER_KEEP_ALIVE_MS,
    recording: input.recording ?? false,
  });
  try {
    const page = await browser.newPage();
    await page.goto(input.url, { waitUntil: "domcontentloaded" });
    const cdp = await page.createCDPSession();
    return new BrowserHandoffSession({ browser, cdp, page });
  } catch (error) {
    try {
      await browser.close();
    } catch (closeError) {
      console.error("Browser Run cleanup after open failure also failed", {
        closeError,
        openError: error,
      });
    }
    throw error;
  }
}

function assertBrowserUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser session URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser session URL must be an absolute http(s) URL.");
  }
}
