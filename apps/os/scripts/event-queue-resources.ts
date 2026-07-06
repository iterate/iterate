import { workerEventsQueueName } from "../src/queue-names.ts";
import type { DeployableEnv, EnvContext } from "../../../scripts/lib/env-context.ts";

type QueueResourceContext = Pick<EnvContext<DeployableEnv>, "cf">;

type QueueRecord = {
  queue_id: string;
  queue_name: string;
};

export async function ensureWorkerEventsQueue(
  ctx: QueueResourceContext,
  workerName: string,
): Promise<QueueRecord> {
  return await ensureQueue(ctx, workerEventsQueueName(workerName));
}

export async function ensureWorkerEventQueueResources(
  ctx: QueueResourceContext,
  workerName: string,
): Promise<QueueRecord> {
  const eventQueue = await ensureWorkerEventsQueue(ctx, workerName);
  await ensureArtifactEventSubscriptions(ctx, {
    queueId: eventQueue.queue_id,
    workerName,
  });
  return eventQueue;
}

async function ensureQueue(ctx: QueueResourceContext, queueName: string): Promise<QueueRecord> {
  const queues = await ctx.cf<QueueRecord[]>(`/queues?per_page=1000`);
  const existing = queues.find((queue) => queue.queue_name === queueName);
  if (existing) {
    console.log(`Queue ${queueName} exists (${existing.queue_id})`);
    return existing;
  }

  const created = await ctx.cf<QueueRecord>(`/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: queueName }),
  });
  console.log(`created Queue ${queueName} (${created.queue_id})`);
  return created;
}

type DesiredArtifactEventSubscription = {
  events: string[];
  name: string;
  source: Record<string, string>;
};

type ArtifactEventSubscription = {
  destination?: { queue_id?: string; type?: string };
  enabled?: boolean;
  events?: string[];
  id: string;
  name?: string;
  source?: Record<string, string | undefined>;
};

async function ensureArtifactEventSubscriptions(
  ctx: QueueResourceContext,
  input: { queueId: string; workerName: string },
): Promise<void> {
  const desired: DesiredArtifactEventSubscription[] = [
    {
      name: `${input.workerName}-artifact-account-events`,
      source: { type: "artifacts" },
      events: ["repo.created", "repo.deleted", "repo.forked", "repo.imported"],
    },
    {
      name: `${input.workerName}-artifact-repo-events`,
      source: {
        type: "artifacts.repo",
        namespace: `${input.workerName}-repos`,
        repo_name: "*",
      },
      events: ["pushed", "cloned", "fetched"],
    },
  ];

  const existing = await listArtifactEventSubscriptions(ctx);
  for (const subscription of desired) {
    const current = existing.find((candidate) => candidate.name === subscription.name);
    if (current && artifactEventSubscriptionMatches(current, subscription, input.queueId)) {
      console.log(`Artifact event subscription ${subscription.name} unchanged`);
      continue;
    }

    if (current) {
      await artifactEventSubscriptionsApi(ctx, "DELETE", `/${current.id}`);
    }
    await artifactEventSubscriptionsApi(ctx, "POST", "", {
      name: subscription.name,
      enabled: true,
      source: subscription.source,
      destination: { type: "queues.queue", queue_id: input.queueId },
      events: subscription.events,
    });
    console.log(
      `Artifact event subscription ${subscription.name} ${current ? "recreated" : "created"}`,
    );
  }
}

async function listArtifactEventSubscriptions(ctx: QueueResourceContext) {
  return await artifactEventSubscriptionsApi<ArtifactEventSubscription[]>(
    ctx,
    "GET",
    `?per_page=1000`,
  );
}

function artifactEventSubscriptionMatches(
  current: ArtifactEventSubscription,
  desired: DesiredArtifactEventSubscription,
  queueId: string,
): boolean {
  if (current.enabled !== true) return false;
  if (current.destination?.type !== "queues.queue") return false;
  if (current.destination.queue_id !== queueId) return false;
  if ([...(current.events ?? [])].sort().join(",") !== [...desired.events].sort().join(",")) {
    return false;
  }
  return Object.entries(desired.source).every(([key, value]) => current.source?.[key] === value);
}

async function artifactEventSubscriptionsApi<T = unknown>(
  ctx: QueueResourceContext,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return await ctx.cf<T>(`/event_subscriptions/subscriptions${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
