// github-sync/processor.ts — when to pull and when to push (contract.ts says why). The calls go
// through the host's `getItx`: `itx.repos` on `/`, and on the connection's log by the rows
// install.ts writes (`itx.repos ⇒ itx.builtins.cd('/').repos`, and `itx.fetch` the same, for a
// pull's git exchange).
import { z } from "zod";
import type { IterateContextApi } from "iterate/api";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import { GithubSyncContract } from "./contract.ts";
import { githubRepositoryOf } from "./github-repository.ts";

type GithubSyncState = ProcessorState<typeof GithubSyncContract>;

const PushWebhook = z.object({
  delivery: z.object({ name: z.literal("push") }),
  body: z.object({
    ref: z.literal("refs/heads/main"),
    repository: z.object({ full_name: z.string() }),
  }),
});
const CommitCompleted = z.object({ path: z.string() });
const GithubSyncInstalled = z.object({ repo: z.string().startsWith("/repos/") });

export class GithubSyncProcessor extends StreamProcessor<GithubSyncState> {
  contract = GithubSyncContract;
  readonly #getItx: () => IterateContextApi & Disposable;
  constructor(getItx: () => IterateContextApi & Disposable) {
    super();
    this.#getItx = getItx;
  }

  reduce({ event }: ReduceArgs<GithubSyncState>): GithubSyncState | undefined {
    if (event.type !== "github-sync/installed") return;
    const installed = GithubSyncInstalled.safeParse(event.payload);
    if (installed.success) return { repo: installed.data.repo };
  }

  processEvent({
    event,
    state,
    append,
    blockProcessorWhile,
  }: ProcessEventArgs<GithubSyncState>): undefined {
    const { repo } = state;
    if (!event || !repo) return;
    const push =
      event.type === "events.iterate.com/github/webhook-received"
        ? PushWebhook.safeParse(event.payload)
        : null;
    const pushedRepository = push?.success ? push.data.body.repository.full_name : null;
    const committed =
      event.type === "events.iterate.com/repo/commit-completed" &&
      CommitCompleted.safeParse(event.payload).data?.path === repo;
    if (!pushedRepository && !committed) return;
    blockProcessorWhile(async () => {
      let outcome;
      {
        using itx = this.#getItx();
        const handle = itx.repos.get(repo);
        const origin = await handle.origin();
        // Not linked to GitHub, or a push to another repository of the installation: not this
        // repo's to sync.
        if (!origin) return;
        if (pushedRepository && githubRepositoryOf(origin) !== pushedRepository) return;
        try {
          outcome = pushedRepository
            ? { pull: await handle.pull() }
            : { push: await handle.push() };
        } catch (error) {
          // A refusal crosses the RPC hop as an Error with its `code` kept; both fields are checked.
          const { code, message } = error as { code?: unknown; message?: unknown };
          outcome = {
            [pushedRepository ? "pull" : "push"]:
              code === "NOT_FAST_FORWARD" ? "not-fast-forward" : "failed",
            error: String(message),
          };
        }
      }
      await append({
        type: "github-sync/synced",
        payload: { repo, trigger: event.offset, ...outcome },
        idempotencyKey: this.idempotencyKey("synced", event),
      });
    });
  }
}
