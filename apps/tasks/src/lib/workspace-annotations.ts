import type { Annotation } from "@plannotator/ui/types";
import type { WorkspaceStreamEvent } from "./tasks-api.ts";

export const WORKSPACE_ANNOTATION_EVENT_PREFIX =
  "events.iterate.com/tasks/plannotator/";
export const WORKSPACE_ANNOTATION_EVENT_TYPES = [
  `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-added`,
  `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-updated`,
  `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-removed`,
];

const EVENT_PAGE_SIZE = 500;

export type WorkspaceAnnotationSnapshot = {
  annotations: Annotation[];
  version: number;
};

export type WorkspaceAnnotationAppend = {
  payload: Record<string, unknown>;
  type: string;
};

/** Small public interface over the workspace stream's annotation journal. */
export class WorkspaceAnnotationJournal {
  readonly #append: (...events: WorkspaceAnnotationAppend[]) => Promise<void>;
  readonly #getEvents: (afterOffset: number) => Promise<WorkspaceStreamEvent[]>;
  readonly #verifiedAuthor: string;

  constructor(input: {
    append: (...events: WorkspaceAnnotationAppend[]) => Promise<void>;
    getEvents: (afterOffset: number) => Promise<WorkspaceStreamEvent[]>;
    verifiedAuthor: string;
  }) {
    this.#append = input.append;
    this.#getEvents = input.getEvents;
    this.#verifiedAuthor = input.verifiedAuthor;
  }

  async snapshot(filePath: string): Promise<WorkspaceAnnotationSnapshot> {
    const events: WorkspaceStreamEvent[] = [];
    let afterOffset = 0;
    while (true) {
      const page = await this.#getEvents(afterOffset);
      events.push(...page);
      if (page.length < EVENT_PAGE_SIZE) break;
      const nextOffset = page.at(-1)?.offset;
      if (nextOffset === undefined || nextOffset <= afterOffset) {
        throw new Error("annotation journal page did not advance");
      }
      afterOffset = nextOffset;
    }
    return workspaceAnnotationSnapshot(events, filePath);
  }

  async add(filePath: string, annotation: Annotation): Promise<Annotation> {
    const accepted = annotationValue(annotation);
    const created = { ...accepted, author: this.#verifiedAuthor, createdA: Date.now() };
    await this.#append({
      payload: { annotation: created, path: normalizePath(filePath) },
      type: `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-added`,
    });
    return created;
  }

  async update(filePath: string, id: string, updates: Partial<Annotation>): Promise<void> {
    if (id.trim() === "") throw new Error("annotation id is required");
    const { author: _author, createdA: _createdA, id: _id, ...accepted } = updates;
    await this.#append({
      payload: { id, path: normalizePath(filePath), updates: accepted },
      type: `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-updated`,
    });
  }

  async remove(filePath: string, id: string): Promise<void> {
    if (id.trim() === "") throw new Error("annotation id is required");
    await this.#append({
      payload: { id, path: normalizePath(filePath) },
      type: `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-removed`,
    });
  }
}

/** Fold the workspace's durable annotation journal for one document. */
export function workspaceAnnotationSnapshot(
  events: WorkspaceStreamEvent[],
  filePath: string,
): WorkspaceAnnotationSnapshot {
  const annotations = new Map<string, Annotation>();
  const targetPath = normalizePath(filePath);
  let version = 0;

  for (const event of [...events].sort((left, right) => left.offset - right.offset)) {
    version = Math.max(version, event.offset);
    if (!event.type.startsWith(WORKSPACE_ANNOTATION_EVENT_PREFIX)) continue;
    const payload = record(event.payload);
    if (normalizePath(string(payload.path)) !== targetPath) continue;

    if (event.type === `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-added`) {
      const annotation = annotationValue(payload.annotation);
      annotations.set(annotation.id, annotation);
      continue;
    }
    const id = string(payload.id);
    if (id === "") continue;
    if (event.type === `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-removed`) {
      annotations.delete(id);
      continue;
    }
    if (event.type === `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-updated`) {
      const current = annotations.get(id);
      if (current !== undefined) {
        annotations.set(id, annotationValue({ ...current, ...record(payload.updates), id }));
      }
    }
  }

  return {
    annotations: [...annotations.values()].sort(
      (left, right) => left.createdA - right.createdA || left.id.localeCompare(right.id),
    ),
    version,
  };
}

export function isWorkspaceAnnotationEventForPath(
  event: WorkspaceStreamEvent,
  filePath: string,
): boolean {
  if (!event.type.startsWith(WORKSPACE_ANNOTATION_EVENT_PREFIX)) return false;
  return normalizePath(string(record(event.payload).path)) === normalizePath(filePath);
}

function annotationValue(value: unknown): Annotation {
  const candidate = record(value);
  const type = string(candidate.type);
  if (
    string(candidate.id) === "" ||
    (type !== "GLOBAL_COMMENT" && string(candidate.blockId) === "") ||
    typeof candidate.startOffset !== "number" ||
    typeof candidate.endOffset !== "number" ||
    !["DELETION", "COMMENT", "GLOBAL_COMMENT"].includes(type) ||
    typeof candidate.originalText !== "string" ||
    typeof candidate.createdA !== "number"
  ) {
    throw new Error("malformed annotation event");
  }
  // Every required runtime field has been checked above; optional fields are
  // retained verbatim so newer Plannotator metadata survives a round trip.
  return candidate as unknown as Annotation;
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
