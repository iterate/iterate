import type { Env } from "../../env.ts";
import { searchIndexQueueName } from "../../queue-names.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { parseSearchIndexQueueTask, type SearchIndexQueueTask } from "./search-index-queue.ts";
import {
  indexStreamSegments,
  mirrorFileToSearchIndexStrict,
  removeFileFromSearchIndexStrict,
  triggerProjectSearchSyncDebounced,
} from "./search-index.ts";

const BETWEEN_TASKS_MS = 50;
const INITIAL_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 32 * 60;

type SearchIndexQueueEnv = Pick<Env, "FILES_BUCKET" | "REPO" | "STREAM" | "WORKER_SELF">;

export function isSearchIndexQueue(queue: string, env: Pick<Env, "WORKER_SELF">): boolean {
  return queue === searchIndexQueueName(env.WORKER_SELF);
}

export function searchIndexRetryDelaySeconds(attempts: number): number {
  const completedAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(
    INITIAL_RETRY_DELAY_SECONDS * 2 ** (completedAttempts - 1),
    MAX_RETRY_DELAY_SECONDS,
  );
}

async function processSearchIndexQueueTask(
  task: SearchIndexQueueTask,
  env: SearchIndexQueueEnv,
): Promise<void> {
  switch (task.type) {
    case "search-index/reconcile-stream-segments": {
      const stream = env.STREAM.getByName(
        DurableObjectNameCodec.stringify(
          { projectId: task.projectId, path: task.path },
          { allowNullProjectId: true },
        ),
      );
      await indexStreamSegments({
        projectId: task.projectId,
        path: task.path,
        segments: task.segments,
        readEvents: (args) => stream.getEvents(args),
      });
      break;
    }
    case "search-index/reconcile-repo": {
      const result = await env.REPO.getByName(
        DurableObjectNameCodec.stringify({ projectId: task.projectId, path: task.path }),
      ).reindexSearch();
      if (result.failed > 0) {
        throw new Error(
          `repo search reconciliation left ${result.failed} failed file write(s) for ${task.path}`,
        );
      }
      break;
    }
    case "search-index/reconcile-file": {
      const object = await env.FILES_BUCKET.get(
        DurableObjectNameCodec.stringify({ projectId: task.projectId, path: task.path }),
      );
      if (object === null) {
        await removeFileFromSearchIndexStrict(task);
      } else {
        await mirrorFileToSearchIndexStrict({
          bytes: new Uint8Array(await object.arrayBuffer()),
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
          path: task.path,
          projectId: task.projectId,
        });
      }
      break;
    }
  }
  await triggerProjectSearchSyncDebounced(task.projectId);
}

export async function handleSearchIndexQueueBatch(
  batch: MessageBatch<unknown>,
  env: SearchIndexQueueEnv,
  options: {
    pause?: (ms: number) => Promise<void>;
    processTask?: (task: SearchIndexQueueTask, env: SearchIndexQueueEnv) => Promise<void>;
  } = {},
): Promise<void> {
  if (!isSearchIndexQueue(batch.queue, env)) {
    console.warn(`[search-index-queue] received batch from unexpected queue ${batch.queue}`);
  }
  const processTask = options.processTask ?? processSearchIndexQueueTask;
  const pause =
    options.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let index = 0; index < batch.messages.length; index += 1) {
    const message = batch.messages[index]!;
    let task: SearchIndexQueueTask | undefined;
    try {
      task = parseSearchIndexQueueTask(message.body);
      await processTask(task, env);
      message.ack();
      // Hold the queue's sole consumer slot briefly after every successful
      // reconciliation. The production binding uses batch size one, so this
      // also bounds pressure across consecutive consumer invocations.
      await pause(BETWEEN_TASKS_MS);
    } catch (error) {
      console.error(
        `[search-index-queue] reconciliation failed for message ${message.id}`,
        task === undefined ? { error } : { error, task: taskLabel(task) },
      );
      message.retry({ delaySeconds: searchIndexRetryDelaySeconds(message.attempts) });
      // A bucket-wide lock presents identically on every object. Do not turn
      // one failure into more slow R2 calls; defer any untouched remainder.
      // Production batches contain exactly one message.
      for (const deferred of batch.messages.slice(index + 1)) {
        deferred.retry({ delaySeconds: searchIndexRetryDelaySeconds(deferred.attempts) });
      }
      return;
    }
  }
}

function taskLabel(task: SearchIndexQueueTask): Record<string, unknown> {
  return {
    type: task.type,
    projectId: task.projectId,
    path: task.path,
    ...(task.type === "search-index/reconcile-stream-segments" ? { segments: task.segments } : {}),
  };
}
