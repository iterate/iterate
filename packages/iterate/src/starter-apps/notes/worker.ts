// The NotesApp Durable Object: hosts the notes stream processor on the notes
// workspace's stream — analysis obligations (frontmatter write-back) and the
// settlement-debounced git commit lane, hence recovery. No query surface:
// notes are ordinary workspace documents, found via glob/readFiles like any
// other file (convergence decision D6).
import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type StreamEvent,
} from "../../sdk.ts";
import { notesRepoPath, notesWorkspacePath } from "./app-ref.ts";
import { analyzeNoteText } from "./analysis.ts";
import { NotesProcessor, type NotesState } from "./processor.ts";

export class NotesApp extends StreamProcessorDurableObject<NotesState> {
  protected readonly streamPath = notesWorkspacePath;
  /** The processor owes background work (analysis attempts, the debounced
   * commit) — an eviction must revive and settle, not drop it. */
  protected readonly recovery = true;

  protected createProcessor(deps: ProcessorHostDeps) {
    return new NotesProcessor({
      ...deps,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      analyze: async (input) => {
        using project = await this.env.ITX.get();
        return await analyzeNoteText(project.ai, input);
      },
      // Each verb opens its own itx session — a stub must not outlive its
      // RPC turn (the facet alarm-proxy pattern).
      workspace: {
        readFile: async (path) => {
          using project = await this.env.ITX.get();
          return await project.workspaces.get(notesWorkspacePath).readFile(path);
        },
        writeFile: async (path, content) => {
          using project = await this.env.ITX.get();
          await project.workspaces.get(notesWorkspacePath).writeFile(path, content);
        },
        dirtyNotePaths: async () => {
          using project = await this.env.ITX.get();
          const status = await project.workspaces.get(notesWorkspacePath).git.status();
          const mount = status.mounts.find((candidate) => candidate.path === notesRepoPath);
          return (mount?.changes || []).map((change) => change.path);
        },
        commit: async (input) => {
          using project = await this.env.ITX.get();
          await project.workspaces.get(notesWorkspacePath).git.commit(input);
        },
      },
    });
  }

  /** Project-worker event delivery calls this after a durable event commits
   * on the notes workspace stream. Catch-up owns validation, ordering,
   * checkpointing, and dedupe. */
  async syncEvent(event: StreamEvent): Promise<void> {
    if (event.path !== notesWorkspacePath) return;
    const registry = await this.registry();
    await registry.catchUp("notes");
    registry.refreshLive();
  }
}
