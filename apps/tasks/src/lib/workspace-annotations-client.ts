import { useMemo, useSyncExternalStore } from "react";
import type { Annotation } from "@plannotator/ui/types";
import { configurePlannotatorUI } from "@plannotator/ui/configure";
import { whoami, withProject } from "./use-checkout.ts";
import type { TasksWorkspace, WorkspaceStreamEvent } from "./tasks-api.ts";
import {
  isWorkspaceAnnotationEventForPath,
  WORKSPACE_ANNOTATION_EVENT_TYPES,
} from "./workspace-annotations.ts";

let verifiedIdentity = "iterate user";

configurePlannotatorUI({
  identityProvider: {
    getIdentity: () => verifiedIdentity,
    isCurrentUser: (author) => author === verifiedIdentity,
    isEditable: () => false,
  },
  storageBackend: window.localStorage,
});

type AnnotationState = {
  annotations: Annotation[];
  error: string | null;
  status: "connecting" | "live";
  version: number;
};

const SERVER_STATE: AnnotationState = {
  annotations: [],
  error: null,
  status: "connecting",
  version: 0,
};

export function useWorkspaceAnnotations(
  checkoutId: string,
  repoPath: string,
  filePath: string,
) {
  const store = useMemo(
    () => new WorkspaceAnnotationsStore(checkoutId, repoPath, filePath),
    [checkoutId, repoPath, filePath],
  );
  const state = useSyncExternalStore(store.subscribe, store.snapshot, () => SERVER_STATE);
  return { ...state, add: store.add, remove: store.remove, update: store.update };
}

class WorkspaceAnnotationsStore {
  readonly #checkoutId: string;
  readonly #repoPath: string;
  readonly #filePath: string;
  readonly #listeners = new Set<() => void>();
  #state: AnnotationState = SERVER_STATE;
  #active = false;
  #poll: ReturnType<typeof setInterval> | null = null;
  #subscription: { unsubscribe(): void } | null = null;

  constructor(checkoutId: string, repoPath: string, filePath: string) {
    this.#checkoutId = checkoutId;
    this.#repoPath = repoPath;
    this.#filePath = filePath;
  }

  snapshot = (): AnnotationState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  add = async (annotation: Annotation): Promise<void> => {
    try {
      const created = await this.#lane((workspace) =>
        workspace.addAnnotation(this.#filePath, annotation),
      );
      this.#set({
        ...this.#state,
        annotations: [
          ...this.#state.annotations.filter((current) => current.id !== created.id),
          created,
        ],
        error: null,
      });
    } catch (cause) {
      this.#fail(cause);
    }
  };

  update = async (id: string, updates: Partial<Annotation>): Promise<void> => {
    const before = this.#state.annotations;
    this.#set({
      ...this.#state,
      annotations: before.map((annotation) =>
        annotation.id === id ? { ...annotation, ...updates, id } : annotation,
      ),
    });
    try {
      await this.#lane((workspace) => workspace.updateAnnotation(this.#filePath, id, updates));
    } catch (cause) {
      this.#set({ ...this.#state, annotations: before });
      this.#fail(cause);
    }
  };

  remove = async (id: string): Promise<void> => {
    const before = this.#state.annotations;
    this.#set({
      ...this.#state,
      annotations: before.filter((annotation) => annotation.id !== id),
    });
    try {
      await this.#lane((workspace) => workspace.removeAnnotation(this.#filePath, id));
    } catch (cause) {
      this.#set({ ...this.#state, annotations: before });
      this.#fail(cause);
    }
  };

  #start(): void {
    this.#active = true;
    void Promise.all([this.#refresh(), whoami()])
      .then(([, user]) => {
        if (!this.#active) return;
        verifiedIdentity = user.name || user.email || user.userId || "agent";
        this.#set({ ...this.#state, status: "live" });
        void this.#connect();
      })
      .catch((cause) => this.#fail(cause));
    this.#poll = setInterval(() => void this.#refresh(), 2_000);
  }

  #stop(): void {
    this.#active = false;
    if (this.#poll !== null) clearInterval(this.#poll);
    this.#poll = null;
    try {
      this.#subscription?.unsubscribe();
    } catch {
      // The Cap'n Web session may already have closed.
    }
    this.#subscription = null;
  }

  async #connect(): Promise<void> {
    try {
      const handle = await this.#lane((workspace) =>
        workspace.subscribeEvents(
          (batch) => this.#onEvents(batch.events),
          this.#state.version,
          WORKSPACE_ANNOTATION_EVENT_TYPES,
        ),
      );
      if (!this.#active) handle.unsubscribe();
      else this.#subscription = handle;
    } catch (cause) {
      this.#fail(cause);
    }
  }

  #onEvents(events: WorkspaceStreamEvent[]): void {
    if (!this.#active) return;
    if (events.some((event) => isWorkspaceAnnotationEventForPath(event, this.#filePath))) {
      void this.#refresh();
    }
  }

  async #refresh(): Promise<void> {
    try {
      const next = await this.#lane((workspace) => workspace.annotations(this.#filePath));
      if (!this.#active || next.version < this.#state.version) return;
      this.#set({ ...next, error: null, status: "live" });
    } catch (cause) {
      this.#fail(cause);
    }
  }

  #lane<T>(operation: (workspace: TasksWorkspace) => Promise<T>): Promise<T> {
    return withProject((project) =>
      operation(project.workspace(this.#checkoutId, this.#repoPath)),
    );
  }

  #fail(cause: unknown): void {
    if (!this.#active) return;
    this.#set({
      ...this.#state,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  #set(state: AnnotationState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
