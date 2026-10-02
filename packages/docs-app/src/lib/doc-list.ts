// One repo's files as the sidebar and the doc list show them, read when the page first wants them
// and again after each commit to the repo. The commit reaches the
// page as the project root's `repo/commit-completed`, pushed to a subscription the list holds only
// while something on the page reads it (React's useSyncExternalStore: the first listener opens it,
// the last one leaving closes it).
import { createContext, use, useSyncExternalStore } from "react";
import { z } from "zod";
import type { AuthenticatedApp } from "iterate/app";
import { repoFiles } from "./docs-repo.ts";

export type DocListState =
  | { kind: "loading" }
  | { kind: "loaded"; paths: string[] }
  | { kind: "failed"; message: string };

/** A commit's event as the list reads it: which repo it was to. */
const CommitCompleted = z.object({ payload: z.object({ path: z.string() }) });

/** The project's root context, as the page's session holds it. */
type Project = Awaited<ReturnType<AuthenticatedApp["api"]["projects"]["get"]>>;

export class DocList {
  #state: DocListState = { kind: "loading" };
  #listeners = new Set<() => void>();
  #open: () => Promise<Project>;
  /** The repo listed, `/repos/<name>`. */
  #repo: string;
  #project: Project | null = null;
  /** Lets go of the open subscription and project; null while nothing reads the list. */
  #close: (() => void) | null = null;

  constructor(open: () => Promise<Project>, repo: string) {
    this.#open = open;
    this.#repo = repo;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#close?.();
        this.#close = null;
      }
    };
  };

  state = () => this.#state;

  /** Read the list again now: after this page made a doc, before the commit's event arrives. */
  reload() {
    if (this.#project) void this.#read(this.#project);
  }

  #set(state: DocListState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #start() {
    const cleanups: (() => void)[] = [];
    let closed = false;
    // what's opened after the list closed is let go at once
    const hold = (cleanup: () => void) => (closed ? cleanup() : void cleanups.push(cleanup));
    this.#close = () => {
      closed = true;
      this.#project = null;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
    void (async () => {
      const project = await this.#open();
      hold(() => project[Symbol.dispose]());
      if (closed) return;
      // subscribed before the first read: a commit between the two is read again, never missed
      const subscription = await project.subscribe({
        consumes: ["events.iterate.com/repo/commit-completed"],
        target: (events) => {
          // capnweb hands each event as a proxy: a plain copy to parse
          const moved = z
            .array(z.unknown())
            .parse(JSON.parse(JSON.stringify(events)))
            .some((event) => CommitCompleted.safeParse(event).data?.payload.path === this.#repo);
          if (moved) void this.#read(project);
        },
      });
      hold(() => subscription[Symbol.dispose]());
      if (closed) return;
      this.#project = project;
      await this.#read(project);
    })().catch((error: unknown) => {
      if (!closed)
        this.#set({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
    });
  }

  async #read(project: Project) {
    try {
      using repo = project.repos.get(this.#repo);
      const { paths } = await repo.listFiles();
      if (this.#project === project) this.#set({ kind: "loaded", paths: repoFiles(paths) });
    } catch (error) {
      if (this.#project === project)
        this.#set({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }
}

/** The project page's one list (routes/_auth/projects.$slug.tsx), for the sidebar and the doc list. */
export const DocListContext = createContext<DocList | null>(null);

/** The page's list, and the docs as it holds them, kept current. */
export function useDocList() {
  const list = use(DocListContext);
  if (!list) throw new Error("useDocList is for a project's page, inside its DocListContext");
  return { list, docs: useSyncExternalStore(list.subscribe, list.state, list.state) };
}
