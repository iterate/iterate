// docs/root.ts — THE DOCS PROCESSOR on the project's root (frames.ts): which docs have been opened,
// by their contexts' paths, and a `docs/commit-noticed` to each one a commit to its repo changed. The doc's processor
// reads the commit itself (processor.ts); the notice only says to look. Its own saves come back
// through here too, and the doc's catch-up finds nothing new.
import { z } from "zod";
import type { IterateContextApi } from "iterate/api";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import { DocsContract } from "./contract.ts";
import { COMMIT_NOTICED, DOC_OPENED, docContextPath } from "./frames.ts";

type DocsState = ProcessorState<typeof DocsContract>;

const DocOpened = z.object({ repo: z.string(), path: z.string() });
const CommitCompleted = z.object({
  path: z.string(),
  commitOid: z.string(),
  changedPaths: z.array(z.string()),
});

export class DocsProcessor extends StreamProcessor<DocsState> {
  contract = DocsContract;
  readonly #getItx: () => IterateContextApi & Disposable;
  constructor(getItx: () => IterateContextApi & Disposable) {
    super();
    this.#getItx = getItx;
  }

  override reduce({ event, state }: ReduceArgs<DocsState>): DocsState | undefined {
    if (event.type !== DOC_OPENED) return;
    const opened = DocOpened.safeParse(event.payload);
    if (!opened.success) return;
    const context = docContextPath(opened.data);
    if (!state.opened.includes(context)) return { opened: [...state.opened, context] };
  }

  override processEvent({
    event,
    state,
    blockProcessorWhile,
  }: ProcessEventArgs<DocsState>): undefined {
    if (event?.type !== "events.iterate.com/repo/commit-completed") return;
    const commit = CommitCompleted.safeParse(event.payload);
    // a repo Docs never opened a doc in (or nested deeper than /repos/<name>) has nothing to tell
    if (!commit.success || !/^\/repos\/[^/]+$/.test(commit.data.path)) return;
    const repo = commit.data.path;
    const changed = commit.data.changedPaths
      .map((path) => docContextPath({ repo, path }))
      .filter((context) => state.opened.includes(context));
    if (changed.length === 0) return;
    blockProcessorWhile(async () => {
      using itx = this.#getItx();
      await Promise.all(
        changed.map((context) =>
          itx.cd(context).append({
            type: COMMIT_NOTICED,
            ephemeral: true,
            payload: { commitOid: commit.data.commitOid },
          }),
        ),
      );
    });
  }
}
