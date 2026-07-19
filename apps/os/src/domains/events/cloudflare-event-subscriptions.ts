import { workerEventsQueueName } from "../../queue-names.ts";

/**
 * Cloudflare Artifacts event subscriptions expose account-level repo lifecycle
 * events and exact-repo Git activity events. The `artifacts.repo` source needs
 * the concrete artifact repo name, so we backfill existing repos at deploy time
 * and add repo subscriptions when account-level create/import/fork events land.
 *
 * https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/#artifacts
 */
export function desiredArtifactAccountEventSubscription(
  workerName: string,
): DesiredArtifactEventSubscription {
  return {
    name: `${workerName}-artifact-account-events`,
    source: { type: "artifacts" },
    events: ["repo.created", "repo.deleted", "repo.forked", "repo.imported"],
  };
}

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
  return (await ensureQueues(api, [workerEventsQueueName(workerName)]))[0]!;
}

/** Ensure a set of named queues from one paginated listing. */
export async function ensureQueues(
  api: CloudflareAccountApi,
  queueNames: readonly string[],
): Promise<QueueRecord[]> {
  const queues = await listCloudflarePages<QueueRecord>(api, `/queues`);
  const byName = new Map(queues.map((queue) => [queue.queue_name, queue]));
  const ensured: QueueRecord[] = [];
  for (const queueName of queueNames) {
    let queue = byName.get(queueName);
    if (queue === undefined) {
      queue = await api<QueueRecord>(`/queues`, {
        method: "POST",
        body: JSON.stringify({ queue_name: queueName }),
      });
      byName.set(queueName, queue);
    }
    ensured.push(queue);
  }
  return ensured;
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

/**
 * Ensure a subscription from a resource-created event without listing the
 * account's entire subscription inventory.
 *
 * Cloudflare permits only one event subscription per source resource. A new
 * repo therefore takes one POST. An at-least-once delivery (including a crash
 * after Cloudflare committed the POST) gets the explicit "already subscribed"
 * response, then recovers the deterministic subscription by binary-searching
 * the API's name-sorted pages. Recovery is O(log n); the ordinary path is O(1).
 */
export async function createOrEnsureArtifactEventSubscription(
  api: CloudflareAccountApi,
  input: {
    desired: DesiredArtifactEventSubscription;
    queueId: string;
  },
): Promise<"created" | "recreated" | "unchanged"> {
  let alreadySubscribedError: CloudflareAccountApiError;
  try {
    return await ensureArtifactEventSubscription(api, { ...input, existing: [] });
  } catch (error) {
    if (!isResourceAlreadySubscribedError(error)) throw error;
    alreadySubscribedError = error;
  }

  const current = await findArtifactEventSubscriptionByName(api, input.desired.name);
  if (current === undefined) {
    throw new Error(
      `Cloudflare reports that ${JSON.stringify(input.desired.source)} is already subscribed, but deterministic subscription ${input.desired.name} was not found`,
      { cause: alreadySubscribedError },
    );
  }
  return await ensureArtifactEventSubscription(api, { ...input, existing: [current] });
}

/** Find one deterministic name without walking every account-level page. */
export async function findArtifactEventSubscriptionByName(
  api: CloudflareAccountApi,
  name: string,
): Promise<ArtifactEventSubscription | undefined> {
  const pages = new Map<number, ArtifactEventSubscription[]>();
  const loadPage = async (page: number) => {
    let subscriptions = pages.get(page);
    if (subscriptions === undefined) {
      subscriptions = await api<ArtifactEventSubscription[]>(
        `/event_subscriptions/subscriptions?page=${page}&per_page=100&order=name&direction=asc`,
      );
      pages.set(page, subscriptions);
    }
    return subscriptions;
  };

  // Discover an upper page bound exponentially. Cloudflare returns an empty
  // successful page beyond the end of the collection.
  let lowPage = 1;
  let highPage = 1;
  for (;;) {
    const subscriptions = await loadPage(highPage);
    if (
      subscriptions.length === 0 ||
      subscriptionName(subscriptions[subscriptions.length - 1]!) >= name
    ) {
      break;
    }
    lowPage = highPage + 1;
    highPage *= 2;
  }

  while (lowPage <= highPage) {
    const page = Math.floor((lowPage + highPage) / 2);
    const subscriptions = await loadPage(page);
    if (subscriptions.length === 0) {
      highPage = page - 1;
      continue;
    }

    const firstName = subscriptionName(subscriptions[0]!);
    const lastName = subscriptionName(subscriptions[subscriptions.length - 1]!);
    if (name < firstName) {
      highPage = page - 1;
    } else if (name > lastName) {
      lowPage = page + 1;
    } else {
      return subscriptions.find((subscription) => subscription.name === name);
    }
  }
  return undefined;
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

export async function queueIdForWorkerEventQueue(
  api: CloudflareAccountApi,
  workerName: string,
): Promise<string> {
  return (await ensureWorkerEventQueue(api, workerName)).queue_id;
}

export function createCloudflareAccountApi(input: {
  accountId: string;
  apiToken: string;
  requestTimeoutMs?: number;
}): CloudflareAccountApi {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const signal =
      init?.signal ??
      (input.requestTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(input.requestTimeoutMs));
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${input.accountId}${path}`,
      {
        ...init,
        signal,
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
      throw new CloudflareAccountApiError({
        errors: body?.errors ?? body,
        method: init?.method ?? "GET",
        path,
        status: response.status,
      });
    }
    return body?.result as T;
  };
}

class CloudflareAccountApiError extends Error {
  readonly errors: unknown;
  readonly status: number;

  constructor(input: { errors: unknown; method: string; path: string; status: number }) {
    super(
      `Cloudflare API ${input.method} ${input.path} failed (${input.status}): ${JSON.stringify(input.errors).slice(0, 500)}`,
    );
    this.name = "CloudflareAccountApiError";
    this.errors = input.errors;
    this.status = input.status;
  }
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

function isResourceAlreadySubscribedError(error: unknown): error is CloudflareAccountApiError {
  if (!(error instanceof CloudflareAccountApiError)) return false;
  const messages = Array.isArray(error.errors)
    ? error.errors.flatMap((candidate) => {
        if (typeof candidate !== "object" || candidate === null || !("message" in candidate)) {
          return [];
        }
        return typeof candidate.message === "string" ? [candidate.message] : [];
      })
    : [];
  return messages.some((message) =>
    message.toLowerCase().includes("do not support multiple subscriptions on the same resource"),
  );
}

function subscriptionName(subscription: ArtifactEventSubscription): string {
  if (typeof subscription.name !== "string") {
    throw new Error(`Cloudflare returned event subscription ${subscription.id} without a name`);
  }
  return subscription.name;
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
