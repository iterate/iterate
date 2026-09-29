// ai-linter/processor.ts — the queue of heads to lint (contract.ts says what the linter is). The
// work runs in `runInBackground` (a model call outlives the 60 s a processor call gets); the queue
// lives in state and `ai-linter/linted` is the outcome, so a host that dies mid-lint is revived and
// lints the head again. Publishing is idempotent: the review carries a marker, the Check Run an
// external_id, and a head that already has its complete Check Run is not linted again.
//
// It reaches GitHub and the model through `itx.fetch` and `itx.ai`, which the connection's log has
// only by the rows install.ts writes (`itx.fetch ⇒ itx.builtins.cd('/').fetch`, the same for `ai`).
import { z } from "zod";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import type { IterateContextApi } from "iterate/api";
import { AiLinterContract, type AiLinterJob } from "./contract.ts";
import { PROMPT_VERSION } from "./lint.ts";
import { DEFAULT_MODEL, lintHead, type Gateway } from "./run.ts";

export type AiLinterState = ProcessorState<typeof AiLinterContract>;

const PullRequestWebhook = z.object({
  delivery: z.object({ name: z.literal("pull_request") }),
  body: z.object({
    action: z.string(),
    repository: z.object({ full_name: z.string() }),
    pull_request: z.object({
      number: z.number(),
      state: z.string(),
      draft: z.boolean().optional(),
      head: z.object({ sha: z.string() }),
      base: z.object({ sha: z.string() }),
    }),
  }),
});
/** The install's choices; the latest marker's hold. */
const AiLinterInstalled = z.object({
  repository: z.string(),
  rules: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const AiLinterLinted = z.object({ key: z.string() });

/** Where a lint keeps what it must not lose to a restart: the host's own storage (a Durable Object's
 *  `ctx.storage`), which outlives an incarnation. */
export type LintStorage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete">;

export class AiLinterProcessor extends StreamProcessor<AiLinterState> {
  contract = AiLinterContract;
  /** Jobs this incarnation is running; state's queue is the truth, this only stops a second start. */
  readonly #running = new Set<string>();
  readonly #getItx: () => IterateContextApi & Disposable;
  readonly #storage: LintStorage;
  constructor(getItx: () => IterateContextApi & Disposable, storage: LintStorage) {
    super();
    this.#getItx = getItx;
    this.#storage = storage;
  }

  reduce({ event, state }: ReduceArgs<AiLinterState>): AiLinterState | undefined {
    if (event.type === "ai-linter/installed") {
      const installed = AiLinterInstalled.safeParse(event.payload);
      if (!installed.success) return;
      const { repository, rules, model } = installed.data;
      return { ...state, repository, rules, model };
    }
    if (event.type === "ai-linter/linted") {
      const linted = AiLinterLinted.safeParse(event.payload);
      if (!linted.success) return;
      return { ...state, queue: state.queue.filter((job) => job.key !== linted.data.key) };
    }
    // Deliveries from before the install marker are history: never linted.
    if (event.type !== "events.iterate.com/github/webhook-received" || !state.repository) return;
    const webhook = PullRequestWebhook.safeParse(event.payload);
    if (!webhook.success) return;
    const { action, repository, pull_request: pull } = webhook.data.body;
    if (repository.full_name !== state.repository) return;
    if (!["opened", "reopened", "ready_for_review", "synchronize"].includes(action)) return;
    if (pull.draft === true || pull.state !== "open") return;
    const key = `ai-linter/v${PROMPT_VERSION}:${repository.full_name}#${pull.number}@${pull.head.sha}`;
    if (state.queue.some((job) => job.key === key)) return;
    const job: z.infer<typeof AiLinterJob> = {
      key,
      offset: event.offset,
      connection: event.path.split("/").pop() ?? "",
      repository: repository.full_name,
      number: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
    };
    // A newer head replaces the pull request's queued one.
    return {
      ...state,
      queue: [...state.queue.filter((queued) => queued.number !== pull.number), job],
    };
  }

  processEvent({
    state,
    delivery,
    append,
    runInBackground,
  }: ProcessEventArgs<AiLinterState>): undefined {
    // Only at the head: an outcome further down the log may already settle the queued job.
    if (!delivery.caughtUp) return;
    const job = state.queue[0];
    if (!job || this.#running.has(job.key)) return;
    this.#running.add(job.key);
    const getItx = this.#getItx;
    const storage = this.#storage;
    // What this head's lint remembered (run.ts `LintIo.remember`), until its outcome is on the log.
    const remembered = `remembered/${job.key}/`;
    runInBackground(async () => {
      try {
        const config = { rules: state.rules || "rules", model: state.model || DEFAULT_MODEL };
        const outcome = await lintHead(job, config, {
          fetch: async (request) => {
            using itx = getItx();
            const response = await itx.fetch(request);
            return { status: response.status, text: await response.text() };
          },
          model: async (model, input, options) => {
            using itx = getItx();
            return await runModel(itx, model, input, options.gateway);
          },
          async remember<T>(key: string, compute: () => Promise<T>) {
            const kept = await storage.get<T>(`${remembered}${key}`);
            if (kept !== undefined) return kept;
            const value = await compute();
            await storage.put(`${remembered}${key}`, value);
            return value;
          },
          projectId: async () => {
            using itx = getItx();
            return (await itx.whoami()).projectId;
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        await append({
          type: "ai-linter/linted",
          payload: { key: job.key, number: job.number, headSha: job.headSha, ...outcome },
          // One outcome per delivery that queued the head: a head delivered again after its outcome
          // (a draft readied, a reopen) is linted again, and its outcome must not collide with the
          // first one's, or the job would never leave the queue.
          idempotencyKey: this.idempotencyKey(`${job.key}@${job.offset}`),
        });
        await storage.delete([...(await storage.list({ prefix: remembered })).keys()]);
      } finally {
        this.#running.delete(job.key);
      }
    });
  }
}

/** A model through the project's Workers AI binding. `Ai.run`'s types list Workers AI's own models;
 *  a partner model (the Responses API) and Jev take their own inputs, so the call is untyped here. */
const runModel = (itx: IterateContextApi, model: string, input: unknown, gateway: Gateway) =>
  (itx.ai as unknown as { run: (...args: unknown[]) => Promise<unknown> }).run(model, input, {
    gateway,
  });
