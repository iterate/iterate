import { expect, it } from "vitest";

import {
  ensureWorkerEventQueue,
  listArtifactEventSubscriptions,
  listArtifactRepos,
} from "../src/domains/events/cloudflare-event-subscriptions.ts";
import { ensureWorkerEventQueueResources } from "./event-queue-resources.ts";

it("lists artifact event subscriptions with Cloudflare's accepted page size", async () => {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  const ctx = {
    cf: async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method ?? "GET",
        path,
      });

      if (path === "/queues?page=1&per_page=100") {
        return [{ queue_id: "queue-1", queue_name: "os-prd-events" }] as T;
      }
      if (path === "/queues" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { queue_name: string };
        return { queue_id: `queue-${body.queue_name}`, queue_name: body.queue_name } as T;
      }
      if (path === "/event_subscriptions/subscriptions?page=1&per_page=100") {
        return [] as T;
      }
      if (path === "/artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100") {
        return [{ name: "prj_123--Lw" }] as T;
      }
      if (path === "/event_subscriptions/subscriptions" && init?.method === "POST") {
        return { id: "subscription-1" } as T;
      }
      throw new Error(`unexpected Cloudflare call ${init?.method ?? "GET"} ${path}`);
    },
  } satisfies Parameters<typeof ensureWorkerEventQueueResources>[0];

  await ensureWorkerEventQueueResources(ctx, "os-prd");

  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "GET /queues?page=1&per_page=100",
    "POST /queues",
    "POST /queues",
    "GET /event_subscriptions/subscriptions?page=1&per_page=100",
    "POST /event_subscriptions/subscriptions",
    "GET /artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100",
    "POST /event_subscriptions/subscriptions",
  ]);
  expect(calls[1]?.body).toEqual({ queue_name: "os-prd-search-index-writes" });
  expect(calls[2]?.body).toEqual({ queue_name: "os-prd-search-index-write-failures" });
  expect(calls[4]?.body).toMatchObject({
    destination: { queue_id: "queue-1", type: "queues.queue" },
    name: "os-prd-artifact-account-events",
    source: { type: "artifacts" },
  });
  expect(calls[6]?.body).toMatchObject({
    destination: { queue_id: "queue-1", type: "queues.queue" },
    name: expect.stringMatching(/^os-prd-artifact-repo-prj_123--Lw-[0-9a-f]{12}$/),
    source: { namespace: "os-prd-repos", repo_name: "prj_123--Lw", type: "artifacts.repo" },
  });
});

it("paginates Cloudflare list endpoints with the accepted page size", async () => {
  const calls: string[] = [];
  const api = async <T>(path: string): Promise<T> => {
    calls.push(path);

    if (path === "/queues?page=1&per_page=100") {
      return Array.from({ length: 100 }, (_, index) => ({
        queue_id: `queue-${index}`,
        queue_name: `unrelated-${index}`,
      })) as T;
    }
    if (path === "/queues?page=2&per_page=100") {
      return [{ queue_id: "queue-target", queue_name: "os-prd-events" }] as T;
    }
    if (path === "/event_subscriptions/subscriptions?page=1&per_page=100") {
      return Array.from({ length: 100 }, (_, index) => ({ id: `subscription-${index}` })) as T;
    }
    if (path === "/event_subscriptions/subscriptions?page=2&per_page=100") {
      return [{ id: "subscription-target" }] as T;
    }
    if (path === "/artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100") {
      return Array.from({ length: 100 }, (_, index) => ({ name: `repo-${index}` })) as T;
    }
    if (path === "/artifacts/namespaces/os-prd-repos/repos?page=2&per_page=100") {
      return [{ name: "repo-target" }] as T;
    }
    throw new Error(`unexpected Cloudflare call ${path}`);
  };

  await expect(ensureWorkerEventQueue(api, "os-prd")).resolves.toMatchObject({
    queue_id: "queue-target",
  });
  await expect(listArtifactEventSubscriptions(api)).resolves.toHaveLength(101);
  await expect(listArtifactRepos(api, "os-prd-repos")).resolves.toHaveLength(101);
  expect(calls).toEqual([
    "/queues?page=1&per_page=100",
    "/queues?page=2&per_page=100",
    "/event_subscriptions/subscriptions?page=1&per_page=100",
    "/event_subscriptions/subscriptions?page=2&per_page=100",
    "/artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100",
    "/artifacts/namespaces/os-prd-repos/repos?page=2&per_page=100",
  ]);
});
