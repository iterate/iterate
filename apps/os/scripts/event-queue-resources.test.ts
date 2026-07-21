import { expect, it } from "vitest";

import {
  desiredArtifactRepoEventSubscription,
  ensureArtifactRepoEventSubscriptionForWorker,
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
      if (path === "/event_subscriptions/subscriptions?queue_id=queue-1&page=1&per_page=100") {
        return [
          {
            destination: { queue_id: "preview-5-queue", type: "queues.queue" },
            enabled: true,
            events: ["repo.created", "repo.deleted", "repo.forked", "repo.imported"],
            id: "preview-5-account-subscription",
            name: "os-preview-5-artifact-account-events",
            source: { type: "artifacts" },
          },
        ] as T;
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
    "GET /event_subscriptions/subscriptions?queue_id=queue-1&page=1&per_page=100",
    "GET /artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100",
    "POST /event_subscriptions/subscriptions",
  ]);
  expect(calls[3]?.body).toMatchObject({
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
    if (path === "/event_subscriptions/subscriptions?queue_id=queue-target&page=1&per_page=100") {
      return Array.from({ length: 100 }, (_, index) => ({ id: `subscription-${index}` })) as T;
    }
    if (path === "/event_subscriptions/subscriptions?queue_id=queue-target&page=2&per_page=100") {
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
  await expect(listArtifactEventSubscriptions(api, "queue-target")).resolves.toHaveLength(101);
  await expect(listArtifactRepos(api, "os-prd-repos")).resolves.toHaveLength(101);
  expect(calls).toEqual([
    "/queues?page=1&per_page=100",
    "/queues?page=2&per_page=100",
    "/event_subscriptions/subscriptions?queue_id=queue-target&page=1&per_page=100",
    "/event_subscriptions/subscriptions?queue_id=queue-target&page=2&per_page=100",
    "/artifacts/namespaces/os-prd-repos/repos?page=1&per_page=100",
    "/artifacts/namespaces/os-prd-repos/repos?page=2&per_page=100",
  ]);
});

it("ensures one exact repo subscription for a worker", async () => {
  const calls: Array<{ body?: unknown; method: string; path: string }> = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      path,
    });
    if (path === "/queues?page=1&per_page=100") {
      return [{ queue_id: "queue-10", queue_name: "os-preview-10-events" }] as T;
    }
    if (
      path ===
      "/event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc&page=1&per_page=100"
    ) {
      return [] as T;
    }
    if (path === "/event_subscriptions/subscriptions" && init?.method === "POST") {
      return { id: "repo-subscription-10" } as T;
    }
    throw new Error(`unexpected Cloudflare call ${init?.method ?? "GET"} ${path}`);
  };

  await expect(
    ensureArtifactRepoEventSubscriptionForWorker(api, {
      repoName: "project-10--repo",
      workerName: "os-preview-10",
    }),
  ).resolves.toBe("created");

  expect(calls).toHaveLength(3);
  expect(calls[2]).toMatchObject({
    body: {
      destination: { queue_id: "queue-10", type: "queues.queue" },
      source: {
        namespace: "os-preview-10-repos",
        repo_name: "project-10--repo",
        type: "artifacts.repo",
      },
    },
    method: "POST",
    path: "/event_subscriptions/subscriptions",
  });
});

it("finds one worker subscription without scanning every subscription page", async () => {
  const desired = await desiredArtifactRepoEventSubscription({
    repoName: "project-10--repo",
    workerName: "os-preview-10",
  });
  const calls: string[] = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/queues?page=1&per_page=100") {
      return [{ queue_id: "queue-10", queue_name: "os-preview-10-events" }] as T;
    }
    const prefix = "/event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc";
    if (path === `${prefix}&page=1&per_page=100`) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: `a-${index}`,
        name: `a-${String(index).padStart(3, "0")}`,
      })) as T;
    }
    if (path === `${prefix}&page=2&per_page=100`) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: `b-${index}`,
        name: `b-${String(index).padStart(3, "0")}`,
      })) as T;
    }
    if (path === `${prefix}&page=4&per_page=100`) return [] as T;
    if (path === `${prefix}&page=3&per_page=100`) {
      return [
        {
          ...desired,
          destination: { queue_id: "queue-10", type: "queues.queue" },
          enabled: true,
          id: "existing-subscription",
        },
      ] as T;
    }
    throw new Error(`unexpected Cloudflare call ${init?.method ?? "GET"} ${path}`);
  };

  await expect(
    ensureArtifactRepoEventSubscriptionForWorker(api, {
      repoName: "project-10--repo",
      workerName: "os-preview-10",
    }),
  ).resolves.toBe("unchanged");
  expect(calls).toEqual([
    "GET /queues?page=1&per_page=100",
    `GET /event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc&page=1&per_page=100`,
    `GET /event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc&page=2&per_page=100`,
    `GET /event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc&page=4&per_page=100`,
    `GET /event_subscriptions/subscriptions?queue_id=queue-10&order=name&direction=asc&page=3&per_page=100`,
  ]);
});
