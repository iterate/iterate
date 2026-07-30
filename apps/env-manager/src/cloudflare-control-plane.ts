import { z } from "zod";

const APIEnvelope = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  errors: z
    .array(z.object({ code: z.number().optional(), message: z.string().optional() }))
    .default([]),
});
const WorkerScript = z.object({ id: z.string() });
const DurableObjectNamespace = z.object({
  id: z.string(),
  script: z.string().nullable(),
});
const ContainerApplication = z.object({
  durable_objects: z.object({ namespace_id: z.string().optional() }).optional(),
  id: z.string(),
  name: z.string(),
});
const ArtifactRepository = z.object({ name: z.string() });

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000];
const ARTIFACT_DELETE_CONCURRENCY = 10;
const ARTIFACT_REPOSITORY_PAGE_SIZE = 50;

class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

function formatErrors(errors: z.infer<typeof APIEnvelope>["errors"]): string {
  return errors
    .map(({ code, message }) => [code, message].filter((value) => value !== undefined).join(": "))
    .join("; ");
}

export function makeCloudflareControlPlane(input: { accountId: string; apiToken: string }) {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}${path}`;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${input.apiToken}`,
          ...(init?.headers ?? {}),
        },
      });
      const envelope = APIEnvelope.parse(await response.json());
      if (response.ok && envelope.success) return envelope.result;

      const error = new CloudflareApiError(
        response.status,
        `Cloudflare ${init?.method ?? "GET"} ${path} failed (${response.status}): ${
          formatErrors(envelope.errors) || response.statusText
        }`,
      );
      const delay = RETRY_DELAYS_MS[attempt];
      if ((response.status !== 429 && response.status < 500) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay * (0.8 + Math.random() * 0.4)));
    }
  };

  const deleteIfPresent = async (path: string): Promise<boolean> => {
    try {
      await request(path, { method: "DELETE" });
      return true;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return false;
      throw error;
    }
  };

  const exists = async (path: string): Promise<boolean> => {
    try {
      await request(path);
      return true;
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return false;
      throw error;
    }
  };

  const listDurableObjectNamespaces = async () => {
    const namespaces: z.infer<typeof DurableObjectNamespace>[] = [];
    for (let page = 1; ; page += 1) {
      const batch = z
        .array(DurableObjectNamespace)
        .parse(await request(`/workers/durable_objects/namespaces?per_page=100&page=${page}`));
      namespaces.push(...batch);
      if (batch.length < 100) return namespaces;
    }
  };

  const listArtifactRepositoryPage = async (namespace: string) => {
    const path = `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`;
    try {
      return z
        .array(ArtifactRepository)
        .parse(await request(`${path}?per_page=${ARTIFACT_REPOSITORY_PAGE_SIZE}`));
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) return [];
      throw error;
    }
  };

  const destroyArtifactRepositories = async (namespace: string) => {
    const path = `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`;
    for (;;) {
      const repositories = await listArtifactRepositoryPage(namespace);
      if (repositories.length === 0) return;
      let deleted = 0;
      for (let index = 0; index < repositories.length; index += ARTIFACT_DELETE_CONCURRENCY) {
        const batch = repositories.slice(index, index + ARTIFACT_DELETE_CONCURRENCY);
        await Promise.all(
          batch.map(async ({ name }) => {
            if (await deleteIfPresent(`${path}/${encodeURIComponent(name)}`)) deleted += 1;
          }),
        );
      }
      if (deleted === 0) {
        const remaining = await listArtifactRepositoryPage(namespace);
        if (remaining.length === 0) return;
        throw new Error(
          `Artifacts cleanup made no progress for ${namespace}; Cloudflare still lists: ${remaining
            .map(({ name }) => name)
            .join(", ")}`,
        );
      }
    }
  };

  const destroyContainerApplications = async (workerName: string) => {
    const namespaceIds = new Set(
      (await listDurableObjectNamespaces())
        .filter(({ script }) => script === workerName)
        .map(({ id }) => id),
    );
    const applications = z
      .array(ContainerApplication)
      .parse(await request("/containers/applications"));
    const owned = applications.filter(({ durable_objects }) => {
      const namespaceId = durable_objects?.namespace_id;
      return namespaceId !== undefined && namespaceIds.has(namespaceId);
    });
    for (const application of owned) {
      await deleteIfPresent(`/containers/applications/${encodeURIComponent(application.id)}`);
    }
    const remaining = z
      .array(ContainerApplication)
      .parse(await request("/containers/applications"))
      .filter(({ durable_objects }) => {
        const namespaceId = durable_objects?.namespace_id;
        return namespaceId !== undefined && namespaceIds.has(namespaceId);
      });
    if (remaining.length > 0) {
      throw new Error(
        `Container applications remain for ${workerName}: ${remaining
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
  };

  return {
    async assertResourcesExist(resources: {
      authDbId: string;
      projectDirectoryKvId: string;
      workerBuildCacheKvId: string;
      semaphoreDbId: string;
      filesBucketName: string;
      sandboxesBucketName: string;
    }) {
      const checks = [
        ["auth D1", `/d1/database/${encodeURIComponent(resources.authDbId)}`],
        [
          "project-directory KV",
          `/storage/kv/namespaces/${encodeURIComponent(resources.projectDirectoryKvId)}`,
        ],
        [
          "worker-build-cache KV",
          `/storage/kv/namespaces/${encodeURIComponent(resources.workerBuildCacheKvId)}`,
        ],
        ["semaphore D1", `/d1/database/${encodeURIComponent(resources.semaphoreDbId)}`],
        ["files R2", `/r2/buckets/${encodeURIComponent(resources.filesBucketName)}`],
        ["sandboxes R2", `/r2/buckets/${encodeURIComponent(resources.sandboxesBucketName)}`],
      ] as const;
      const results = await Promise.all(
        checks.map(async ([label, path]) => ({ label, present: await exists(path) })),
      );
      const missing = results.filter(({ present }) => !present).map(({ label }) => label);
      if (missing.length > 0) {
        throw new Error(`Cloudflare resources are missing: ${missing.join(", ")}`);
      }
    },

    async destroyWranglerEnvironment(
      input: {
        osWorkerName?: string;
      } & (
        | { previewSlot: number; workerNames?: never }
        | { previewSlot?: never; workerNames: string[] }
      ),
    ) {
      let workerNames: string[];
      if ("previewSlot" in input) {
        const previewWorkerPattern = new RegExp(`(?:^|-)preview-${input.previewSlot}(?:-|$)`);
        workerNames = z
          .array(WorkerScript)
          .parse(await request("/workers/scripts"))
          .filter(({ id }) => previewWorkerPattern.test(id))
          .map(({ id }) => id);
      } else {
        workerNames = input.workerNames;
      }

      if (input.osWorkerName !== undefined) {
        await destroyContainerApplications(input.osWorkerName);
      }

      // Worker deletion intentionally stays sequential. These control-plane
      // calls are rate-limited per API user and force deletion also removes
      // every Durable Object namespace, instance, alarm, and storage row.
      for (const workerName of workerNames) {
        await deleteIfPresent(`/workers/scripts/${encodeURIComponent(workerName)}?force=true`);
      }

      const targetWorkers = new Set(workerNames);
      const remainingWorkers = z
        .array(WorkerScript)
        .parse(await request("/workers/scripts"))
        .filter(({ id }) => targetWorkers.has(id));
      const remainingNamespaces = (await listDurableObjectNamespaces()).filter(
        ({ script }) => script !== null && targetWorkers.has(script),
      );
      if (remainingWorkers.length > 0 || remainingNamespaces.length > 0) {
        throw new Error(
          [
            remainingWorkers.length > 0
              ? `Workers remain: ${remainingWorkers.map(({ id }) => id).join(", ")}`
              : undefined,
            remainingNamespaces.length > 0
              ? `Durable Object namespaces remain for: ${[
                  ...new Set(remainingNamespaces.map(({ script }) => script)),
                ].join(", ")}`
              : undefined,
          ]
            .filter((message) => message !== undefined)
            .join("; "),
        );
      }

      if (input.osWorkerName !== undefined) {
        await destroyArtifactRepositories(`${input.osWorkerName}-repos`);
      }
    },
  };
}
