import {
  deleteArtifactEventSubscription,
  desiredArtifactAccountEventSubscription,
  desiredArtifactRepoEventSubscription,
  ensureArtifactEventSubscription,
  ensureWorkerEventQueue,
  listArtifactEventSubscriptions,
  listArtifactRepos,
  type QueueRecord,
} from "../src/domains/events/cloudflare-event-subscriptions.ts";
import type { DeployableEnv, EnvContext } from "../../../scripts/lib/env-context.ts";

type QueueResourceContext = Pick<EnvContext<DeployableEnv>, "cf">;

export async function ensureWorkerEventsQueue(
  ctx: QueueResourceContext,
  workerName: string,
): Promise<QueueRecord> {
  const queue = await ensureWorkerEventQueue(ctx.cf, workerName);
  console.log(`Queue ${queue.queue_name} exists (${queue.queue_id})`);
  return queue;
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

async function ensureArtifactEventSubscriptions(
  ctx: QueueResourceContext,
  input: { queueId: string; workerName: string },
): Promise<void> {
  const existing = await listArtifactEventSubscriptions(ctx.cf);
  const legacyWildcard = existing.find(
    (subscription) => subscription.name === `${input.workerName}-artifact-repo-events`,
  );
  if (legacyWildcard) {
    await deleteArtifactEventSubscription(ctx.cf, legacyWildcard.id);
    existing.splice(existing.indexOf(legacyWildcard), 1);
    console.log(`Artifact event subscription ${legacyWildcard.name} deleted`);
  }

  logEnsure(
    await ensureArtifactEventSubscription(ctx.cf, {
      desired: desiredArtifactAccountEventSubscription(input.workerName),
      existing,
      queueId: input.queueId,
    }),
    `${input.workerName}-artifact-account-events`,
  );

  const namespace = `${input.workerName}-repos`;
  const repos = await listArtifactRepos(ctx.cf, namespace);
  for (const repo of repos) {
    const desired = await desiredArtifactRepoEventSubscription({
      repoName: repo.name,
      workerName: input.workerName,
    });
    logEnsure(
      await ensureArtifactEventSubscription(ctx.cf, {
        desired,
        existing,
        queueId: input.queueId,
      }),
      desired.name,
    );
  }
}

function logEnsure(result: "created" | "recreated" | "unchanged", subscriptionName: string) {
  console.log(`Artifact event subscription ${subscriptionName} ${result}`);
}
