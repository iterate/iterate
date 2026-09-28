// docs/root.ts — THE DOCS PROCESSOR on the project's root (frames.ts): which docs have been opened,
// and a `docs/commit-noticed` to each one a commit to /repos/docs changed. The doc's processor
// reads the commit itself (processor.ts); the notice only says to look. Its own saves come back
// through here too, and the doc's catch-up finds nothing new.
import { z } from "zod";
import type { WithItx } from "iterate/sdk";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import { DocsContract } from "./contract.ts";
import { COMMIT_NOTICED, DOC_OPENED, DOCS_REPO, docContextPath } from "./frames.ts";

type DocsState = ProcessorState<typeof DocsContract>;

const DocOpened = z.object({ path: z.string() });
const CommitCompleted = z.object({
  path: z.string(),
  commitOid: z.string(),
  changedPaths: z.array(z.string()),
});

export class DocsProcessor extends StreamProcessor<DocsState> {
  contract = DocsContract;
  readonly #withItx: WithItx;
  constructor(withItx: WithItx) {
    super();
    this.#withItx = withItx;
  }

  override reduce({ event, state }: ReduceArgs<DocsState>): DocsState | undefined {
    if (event.type !== DOC_OPENED) return;
    const opened = DocOpened.safeParse(event.payload);
    if (opened.success && !state.opened.includes(opened.data.path))
      return { opened: [...state.opened, opened.data.path] };
  }

  override processEvent({
    event,
    state,
    blockProcessorWhile,
  }: ProcessEventArgs<DocsState>): undefined {
    if (event?.type !== "events.iterate.com/repo/commit-completed") return;
    const commit = CommitCompleted.safeParse(event.payload);
    if (!commit.success || commit.data.path !== DOCS_REPO) return;
    const changed = commit.data.changedPaths.filter((path) => state.opened.includes(path));
    if (changed.length === 0) return;
    blockProcessorWhile(() =>
      this.#withItx((itx) =>
        Promise.all(
          changed.map((path) =>
            itx.cd(docContextPath(path)).append({
              type: COMMIT_NOTICED,
              ephemeral: true,
              payload: { commitOid: commit.data.commitOid },
            }),
          ),
        ),
      ),
    );
  }
}
