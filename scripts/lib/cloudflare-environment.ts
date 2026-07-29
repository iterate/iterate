import { z } from "zod";
import { CloudflareApiError, type DeployableEnv, type EnvContext } from "./env-context.ts";

type CfContext = Pick<EnvContext<DeployableEnv>, "cf">;

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
const ARTIFACT_DELETE_CONCURRENCY = 10;
const ARTIFACT_REPOSITORY_PAGE_SIZE = 50;

async function listDurableObjectNamespaces(ctx: CfContext) {
  const namespaces: z.infer<typeof DurableObjectNamespace>[] = [];
  for (let page = 1; ; page += 1) {
    const batch = z
      .array(DurableObjectNamespace)
      .parse(await ctx.cf(`/workers/durable_objects/namespaces?per_page=100&page=${page}`));
    namespaces.push(...batch);
    if (batch.length < 100) return namespaces;
  }
}

async function deleteIfPresent(ctx: CfContext, path: string) {
  try {
    await ctx.cf(path, { method: "DELETE" });
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return false;
    throw error;
  }
}

async function listArtifactRepositoryPage(ctx: CfContext, namespace: string) {
  const path = `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`;
  try {
    return z
      .array(ArtifactRepository)
      .parse(await ctx.cf(`${path}?per_page=${ARTIFACT_REPOSITORY_PAGE_SIZE}`));
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return [];
    throw error;
  }
}

async function destroyArtifactRepositories(ctx: CfContext, namespace: string) {
  const path = `/artifacts/namespaces/${encodeURIComponent(namespace)}/repos`;
  // This endpoint is cursor-paginated. Deleting the current page and then
  // reading page one again avoids carrying a cursor across a mutating result set.
  for (;;) {
    const repositories = await listArtifactRepositoryPage(ctx, namespace);
    if (repositories.length === 0) break;
    let deleted = 0;
    for (let index = 0; index < repositories.length; index += ARTIFACT_DELETE_CONCURRENCY) {
      const batch = repositories.slice(index, index + ARTIFACT_DELETE_CONCURRENCY);
      await Promise.all(
        batch.map(async (repository) => {
          if (await deleteIfPresent(ctx, `${path}/${encodeURIComponent(repository.name)}`)) {
            deleted += 1;
            console.log(`deleted Artifacts repository ${namespace}/${repository.name}`);
          }
        }),
      );
    }
    if (deleted === 0) {
      throw new Error(
        `Artifacts cleanup made no progress for ${namespace}; Cloudflare still lists: ${repositories
          .map(({ name }) => name)
          .join(", ")}`,
      );
    }
  }
  console.log(
    `Artifacts namespace ${namespace} is empty (Cloudflare exposes no namespace delete API).`,
  );
}

async function destroyContainerApplications(ctx: CfContext, workerName: string) {
  const namespaceIds = new Set(
    (await listDurableObjectNamespaces(ctx))
      .filter((namespace) => namespace.script === workerName)
      .map((namespace) => namespace.id),
  );
  const applications = z
    .array(ContainerApplication)
    .parse(await ctx.cf("/containers/applications"));
  const owned = applications.filter((application) => {
    const namespaceId = application.durable_objects?.namespace_id;
    return namespaceId !== undefined && namespaceIds.has(namespaceId);
  });
  for (const application of owned) {
    if (
      await deleteIfPresent(ctx, `/containers/applications/${encodeURIComponent(application.id)}`)
    ) {
      console.log(`deleted container application ${application.name}`);
    }
  }

  const remaining = z
    .array(ContainerApplication)
    .parse(await ctx.cf("/containers/applications"))
    .filter((application) => {
      const namespaceId = application.durable_objects?.namespace_id;
      return namespaceId !== undefined && namespaceIds.has(namespaceId);
    });
  if (remaining.length > 0) {
    throw new Error(
      `Container applications remain for ${workerName}: ${remaining.map(({ name }) => name).join(", ")}`,
    );
  }
}

/**
 * Destroy every Wrangler-owned resource in an environment. Force-deleting a
 * Worker is Cloudflare's supported whole-namespace Durable Object deletion:
 * its classes, instances, storage, and alarms are deleted with the script.
 */
export async function destroyWranglerEnvironment(input: {
  ctx: CfContext;
  workerNames: string[];
  osWorkerName?: string;
}) {
  if (input.osWorkerName) {
    await destroyContainerApplications(input.ctx, input.osWorkerName);
  }

  for (const workerName of input.workerNames) {
    if (
      await deleteIfPresent(
        input.ctx,
        `/workers/scripts/${encodeURIComponent(workerName)}?force=true`,
      )
    ) {
      console.log(`deleted Worker ${workerName}`);
    }
  }

  const targetWorkers = new Set(input.workerNames);
  const remainingWorkers = z
    .array(WorkerScript)
    .parse(await input.ctx.cf("/workers/scripts"))
    .filter(({ id }) => targetWorkers.has(id));
  const remainingNamespaces = (await listDurableObjectNamespaces(input.ctx)).filter(
    (namespace) => namespace.script !== null && targetWorkers.has(namespace.script),
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
        .filter(Boolean)
        .join("; "),
    );
  }

  if (input.osWorkerName) {
    await destroyArtifactRepositories(input.ctx, `${input.osWorkerName}-repos`);
  }
}
