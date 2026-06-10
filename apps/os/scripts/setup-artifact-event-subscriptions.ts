#!/usr/bin/env npx tsx

import { os as orpc } from "@orpc/server";
import { z } from "zod";

/**
 * Create (or repair) the Cloudflare event subscriptions that feed the
 * `${workerName}-artifact-events` queue consumed by the OS worker.
 *
 * Two subscriptions per environment:
 *
 * - account-level Artifacts events (`repo.created` etc). Cloudflare does not
 *   support namespace filtering for the `artifacts` source, so on shared
 *   accounts (dev/preview) this also delivers events for other stages'
 *   namespaces; consumers filter on `source.namespace`.
 * - repo-level events (`pushed`, `cloned`, `fetched`) scoped to this stage's
 *   Artifacts namespace via `repo_name: "*"`.
 *
 * Docs: https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
 */

const SetupArtifactEventSubscriptionsInput = z.object({
  accountId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Cloudflare account ID. Defaults to CLOUDFLARE_ACCOUNT_ID."),
  apiToken: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Cloudflare API token. Defaults to CLOUDFLARE_API_TOKEN_DEV_JONAS or CLOUDFLARE_API_TOKEN.",
    ),
  workerName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("OS worker name, e.g. os-prd. Defaults to the active Doppler/Alchemy stage."),
});

type Options = {
  accountId: string;
  apiToken: string;
  workerName: string;
};

export const setupArtifactEventSubscriptionsScript = orpc
  .input(SetupArtifactEventSubscriptionsInput)
  .meta({
    description:
      "Create or repair the Cloudflare event subscriptions feeding the artifact-events queue",
  })
  .handler(async ({ input }) => setupArtifactEventSubscriptions(resolveOptions(input)));

async function setupArtifactEventSubscriptions(options: Options) {
  const queueName = `${options.workerName}-artifact-events`;
  const queueId = await findQueueId(options, queueName);
  if (!queueId) {
    throw new Error(
      `Queue ${queueName} not found. Deploy the OS worker for this stage first (alchemy creates the queue).`,
    );
  }

  const desired: Array<{ events: string[]; name: string; source: Record<string, string> }> = [
    {
      name: `${options.workerName}-artifact-account-events`,
      source: { type: "artifacts" },
      events: ["repo.created", "repo.deleted", "repo.forked", "repo.imported"],
    },
    {
      name: `${options.workerName}-artifact-repo-events`,
      source: {
        type: "artifacts.repo",
        namespace: `${options.workerName}-repos`,
        repo_name: "*",
      },
      events: ["pushed", "cloned", "fetched"],
    },
  ];

  const existing = await listSubscriptions(options);
  const results: Array<{ name: string; action: "created" | "recreated" | "unchanged" }> = [];

  for (const subscription of desired) {
    const current = existing.find((candidate) => candidate.name === subscription.name);
    if (current && subscriptionMatches(current, subscription, queueId)) {
      results.push({ name: subscription.name, action: "unchanged" });
      continue;
    }

    if (current) {
      await subscriptionsApi(options, "DELETE", `/${current.id}`);
    }
    await subscriptionsApi(options, "POST", "", {
      name: subscription.name,
      enabled: true,
      source: subscription.source,
      destination: { type: "queues.queue", queue_id: queueId },
      events: subscription.events,
    });
    results.push({ name: subscription.name, action: current ? "recreated" : "created" });
  }

  for (const result of results) {
    console.info(`${result.name}: ${result.action}`);
  }
  return { queue: queueName, subscriptions: results };
}

type Subscription = {
  destination?: { queue_id?: string; type?: string };
  enabled?: boolean;
  events?: string[];
  id: string;
  name?: string;
  source?: { namespace?: string; repo_name?: string; type?: string };
};

function subscriptionMatches(
  current: Subscription,
  desired: { events: string[]; source: Record<string, string> },
  queueId: string,
) {
  if (current.enabled !== true) return false;
  if (current.destination?.queue_id !== queueId) return false;
  if ([...(current.events ?? [])].sort().join(",") !== [...desired.events].sort().join(",")) {
    return false;
  }
  return Object.entries(desired.source).every(
    ([key, value]) => current.source?.[key as keyof Subscription["source"]] === value,
  );
}

async function findQueueId(options: Options, queueName: string) {
  for (let page = 1; page <= 10; page += 1) {
    const response = await cloudflareApi<Array<{ queue_id: string; queue_name: string }>>(
      options,
      "GET",
      `/queues?page=${page}&per_page=100`,
    );
    const queues = response.result ?? [];
    const match = queues.find((queue) => queue.queue_name === queueName);
    if (match) return match.queue_id;
    if (queues.length < 100) return null;
  }
  return null;
}

async function listSubscriptions(options: Options) {
  const subscriptions: Subscription[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await subscriptionsApi<Subscription[]>(
      options,
      "GET",
      `?page=${page}&per_page=100`,
    );
    const batch = response.result ?? [];
    subscriptions.push(...batch);
    if (batch.length < 100) break;
  }
  return subscriptions;
}

async function subscriptionsApi<T = unknown>(
  options: Options,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return cloudflareApi<T>(options, method, `/event_subscriptions/subscriptions${path}`, body);
}

async function cloudflareApi<T = unknown>(
  options: Options,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      ...(body == null ? {} : { "Content-Type": "application/json" }),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const parsed = (await response.json()) as {
    errors?: Array<{ code: number; message: string }>;
    result?: T;
    success?: boolean;
  };
  if (!response.ok || parsed.success === false) {
    throw new Error(
      `${method} ${path} failed (${response.status}): ${JSON.stringify(parsed.errors ?? parsed)}`,
    );
  }
  return parsed;
}

function resolveOptions(input: z.infer<typeof SetupArtifactEventSubscriptionsInput>): Options {
  return {
    accountId: input.accountId ?? requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    apiToken:
      input.apiToken ??
      process.env.CLOUDFLARE_API_TOKEN_DEV_JONAS ??
      requireEnv("CLOUDFLARE_API_TOKEN"),
    workerName: input.workerName ?? inferWorkerName() ?? requireEnv("OS_WORKER_NAME"),
  };
}

function inferWorkerName() {
  // Mirrors initAlchemy's `workerName = slugify(`${slug}-${stage}`)`, e.g.
  // prd -> os-prd, preview_3 -> os-preview-3, dev_jonas -> os-dev-jonas.
  const stage = process.env.ALCHEMY_STAGE?.trim();
  if (stage) return slugify(`os-${stage}`);

  const baseUrl = process.env.APP_CONFIG_BASE_URL?.trim();
  if (!baseUrl) return null;
  const hostname = new URL(baseUrl).hostname;
  const previewMatch = /^os\.iterate-preview-(\d+)\.com$/.exec(hostname);
  if (previewMatch) return `os-preview-${previewMatch[1]}`;
  const devMatch = /^os\.iterate-dev-([^.]+)\.com$/.exec(hostname);
  if (devMatch) return `os-dev-${devMatch[1]}`;
  if (hostname === "os.iterate.com") return "os-prd";
  return null;
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}
