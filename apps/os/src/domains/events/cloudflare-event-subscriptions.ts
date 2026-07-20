import { workerEventsQueueName } from "../../queue-names.ts";

/**
 * An Artifacts account permits only one account-level `artifacts` source, so
 * OS deployments subscribe each concrete repository directly. Deploy-time
 * setup backfills existing repos; the repo Durable Object installs the same
 * exact-repo subscription whenever it creates or replaces one.
 *
 * https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#artifacts
 */
export async function desiredArtifactRepoEventSubscription(input: {
  repoName: string;
  workerName: string;
}): Promise<DesiredArtifactEventSubscription> {
  return {
    name: await artifactRepoEventSubscriptionName(input.workerName, input.repoName),
    source: {
      type: "artifacts.repo",
      namespace: `${input.workerName}-repos`,
      repo_name: input.repoName,
    },
    events: ["pushed", "cloned", "fetched"],
  };
}

async function artifactRepoEventSubscriptionName(workerName: string, repoName: string) {
  const prefix = repoName.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(repoName));
  const hash = Array.from(new Uint8Array(digest.slice(0, 6)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${workerName}-artifact-repo-${prefix}-${hash}`;
}

export async function ensureWorkerEventQueue(api: CloudflareAccountApi, workerName: string) {
  return await ensureQueue(api, workerEventsQueueName(workerName));
}

export async function ensureArtifactRepoEventSubscriptionForWorker(
  api: CloudflareAccountApi,
  input: { repoName: string; workerName: string },
): Promise<"created" | "recreated" | "unchanged"> {
  const [queue, existing, desired] = await Promise.all([
    ensureWorkerEventQueue(api, input.workerName),
    listArtifactEventSubscriptions(api),
    desiredArtifactRepoEventSubscription(input),
  ]);
  return await ensureArtifactEventSubscription(api, {
    desired,
    existing,
    queueId: queue.queue_id,
  });
}

export async function listArtifactRepos(
  api: CloudflareAccountApi,
  namespace: string,
): Promise<Array<{ name: string }>> {
  return await listCloudflarePages(
    api,
    `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`,
  );
}

export async function listArtifactEventSubscriptions(api: CloudflareAccountApi) {
  return await listCloudflarePages<ArtifactEventSubscription>(
    api,
    `/event_subscriptions/subscriptions`,
  );
}

export async function ensureArtifactEventSubscription(
  api: CloudflareAccountApi,
  input: {
    desired: DesiredArtifactEventSubscription;
    existing: ArtifactEventSubscription[];
    queueId: string;
  },
): Promise<"created" | "recreated" | "unchanged"> {
  const current = input.existing.find((candidate) => candidate.name === input.desired.name);
  if (current && artifactEventSubscriptionMatches(current, input.desired, input.queueId)) {
    return "unchanged";
  }

  if (current) {
    await artifactEventSubscriptionsApi(api, "DELETE", `/${current.id}`);
  }
  const created = await artifactEventSubscriptionsApi<ArtifactEventSubscription>(api, "POST", "", {
    name: input.desired.name,
    enabled: true,
    source: input.desired.source,
    destination: { type: "queues.queue", queue_id: input.queueId },
    events: input.desired.events,
  });
  input.existing.splice(
    current === undefined ? input.existing.length : input.existing.indexOf(current),
    current === undefined ? 0 : 1,
    {
      ...created,
      destination: { type: "queues.queue", queue_id: input.queueId },
      enabled: true,
      events: input.desired.events,
      name: input.desired.name,
      source: input.desired.source,
    },
  );
  return current ? "recreated" : "created";
}

export async function deleteArtifactEventSubscription(
  api: CloudflareAccountApi,
  subscriptionId: string,
): Promise<void> {
  await artifactEventSubscriptionsApi(api, "DELETE", `/${subscriptionId}`);
}

export function createCloudflareAccountApi(input: {
  accountId: string;
  apiToken: string;
}): CloudflareAccountApi {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${input.accountId}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${input.apiToken}`,
          ...(init?.body && typeof init.body === "string"
            ? { "content-type": "application/json" }
            : {}),
          ...init?.headers,
        },
      },
    );
    const body = (await response.json().catch(() => null)) as {
      errors?: unknown;
      result?: unknown;
      success?: boolean;
    } | null;
    if (!response.ok || body?.success === false) {
      throw new Error(
        `Cloudflare API ${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 500)}`,
      );
    }
    return body?.result as T;
  };
}

async function ensureQueue(api: CloudflareAccountApi, queueName: string): Promise<QueueRecord> {
  const queues = await listCloudflarePages<QueueRecord>(api, `/queues`);
  const existing = queues.find((queue) => queue.queue_name === queueName);
  if (existing) return existing;

  return await api<QueueRecord>(`/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: queueName }),
  });
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

async function listCloudflarePages<T>(
  api: CloudflareAccountApi,
  path: string,
  perPage = 100,
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await api<T[]>(`${path}${separator}page=${page}&per_page=${perPage}`);
    results.push(...items);
    if (items.length < perPage) return results;
  }
}

async function artifactEventSubscriptionsApi<T = unknown>(
  api: CloudflareAccountApi,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return await api<T>(`/event_subscriptions/subscriptions${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type CloudflareAccountApi = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

export type QueueRecord = {
  queue_id: string;
  queue_name: string;
};

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
