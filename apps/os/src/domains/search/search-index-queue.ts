import { itxEnv } from "../../env.ts";
import { normalizePath } from "../durable-object-names.ts";

const SEARCH_INDEX_QUEUE_TASK_VERSION = 1 as const;

/**
 * Tiny, idempotent pointers to authoritative state. Queue delivery may be
 * duplicated or reordered: every consumer re-reads the latest stream segment,
 * repo HEAD, or file path before reconciling the derived R2 document.
 */
export type SearchIndexQueueTask =
  | {
      type: "search-index/reconcile-stream-segments";
      version: typeof SEARCH_INDEX_QUEUE_TASK_VERSION;
      projectId: string;
      path: string;
      segments: number[];
    }
  | {
      type: "search-index/reconcile-repo";
      version: typeof SEARCH_INDEX_QUEUE_TASK_VERSION;
      projectId: string;
      path: string;
    }
  | {
      type: "search-index/reconcile-file";
      version: typeof SEARCH_INDEX_QUEUE_TASK_VERSION;
      projectId: string;
      path: string;
    };

export async function enqueueSearchIndexTask(
  task: SearchIndexQueueTask,
  queue: Queue<SearchIndexQueueTask> = itxEnv.SEARCH_INDEX_QUEUE,
): Promise<void> {
  await queue.send(task, { contentType: "json" });
}

export function enqueueStreamSearchIndex(input: {
  path: string;
  projectId: string;
  segments: number[];
}): Promise<void> {
  return enqueueSearchIndexTask({
    type: "search-index/reconcile-stream-segments",
    version: SEARCH_INDEX_QUEUE_TASK_VERSION,
    ...input,
  });
}

export function enqueueRepoSearchIndex(input: { path: string; projectId: string }): Promise<void> {
  return enqueueSearchIndexTask({
    type: "search-index/reconcile-repo",
    version: SEARCH_INDEX_QUEUE_TASK_VERSION,
    ...input,
  });
}

export function enqueueFileSearchIndex(input: { path: string; projectId: string }): Promise<void> {
  return enqueueSearchIndexTask({
    type: "search-index/reconcile-file",
    version: SEARCH_INDEX_QUEUE_TASK_VERSION,
    ...input,
  });
}

export function parseSearchIndexQueueTask(body: unknown): SearchIndexQueueTask {
  const record = asRecord(body);
  if (record === null || record.version !== SEARCH_INDEX_QUEUE_TASK_VERSION) {
    throw new Error("invalid search-index queue task version");
  }
  const projectId = requiredProjectId(record.projectId);
  const path = normalizePath(requiredString(record.path, "path"));
  switch (record.type) {
    case "search-index/reconcile-stream-segments": {
      if (!Array.isArray(record.segments) || record.segments.length === 0) {
        throw new Error("stream search-index task requires at least one segment");
      }
      const segments = [...new Set(record.segments)];
      if (
        segments.length > 1000 ||
        segments.some((segment) => !Number.isSafeInteger(segment) || Number(segment) < 0)
      ) {
        throw new Error("stream search-index task contains an invalid segment");
      }
      return {
        type: record.type,
        version: SEARCH_INDEX_QUEUE_TASK_VERSION,
        projectId,
        path,
        segments: segments as number[],
      };
    }
    case "search-index/reconcile-repo":
    case "search-index/reconcile-file":
      return {
        type: record.type,
        version: SEARCH_INDEX_QUEUE_TASK_VERSION,
        projectId,
        path,
      };
    default:
      throw new Error(`unrecognized search-index queue task type ${String(record.type)}`);
  }
}

function requiredProjectId(value: unknown): string {
  const projectId = requiredString(value, "projectId");
  if (!/^prj_[a-z0-9_-]+$/.test(projectId)) {
    throw new Error("search-index queue task has an invalid projectId");
  }
  return projectId;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`search-index queue task requires ${name}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
