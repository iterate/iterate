// Project Secrets, post-clean-cut: the journal-backed Secret domain objects
// are THE store. Listing enumerates Secret DOs from the catalog by project;
// reads are the DO's material-free describe(); writes append set/deleted
// facts. The legacy D1 project_secrets table is gone — the contract's
// id/key both carry the Secret's slug.

import { env } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { listD1ObjectCatalogRecordsByIndex } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import {
  ensureSecretStub,
  type SecretDescription,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import { setJournaledSecret } from "~/domains/secrets/secret-streams.ts";
import { secretStreamPath } from "~/domains/secrets/stream-processors/secret/contract.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { os, projectScopeMiddleware } from "~/orpc/orpc.ts";
import { requireProjectScope } from "~/orpc/project-access.ts";

type SecretsRouterEnv = {
  DO_CATALOG: D1Database;
  STREAM: StreamDurableObjectNamespace;
};

export const projectSecretsRouter = {
  list: os.project.secrets.list.use(projectScopeMiddleware).handler(async ({ context }) => {
    const project = requireProjectScope(context);
    const records = await listD1ObjectCatalogRecordsByIndex<{ projectId: string; slug: string }>(
      (env as unknown as SecretsRouterEnv).DO_CATALOG,
      { className: "SecretDurableObject", indexName: "projectId", indexValue: project.id },
    );
    const secrets = [];
    for (const record of records) {
      const slug = record.structuredName.slug;
      const described = await describeSecret(project.id, slug);
      if (described.status === "deleted") continue;
      secrets.push(toSummary({ projectId: project.id, slug, record, described }));
    }
    return { secrets };
  }),
  get: os.project.secrets.get.use(projectScopeMiddleware).handler(async ({ context, input }) => {
    const project = requireProjectScope(context);
    const described = await describeSecret(project.id, input.id);
    if (described.status === "unset") {
      throw new ORPCError("NOT_FOUND", { message: `Secret ${input.id} was not found.` });
    }
    return toSummary({ projectId: project.id, slug: input.id, described });
  }),
  upsert: os.project.secrets.upsert
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      await setJournaledSecret({
        projectId: project.id,
        slug: input.key,
        material: input.material,
        metadata: input.metadata,
        source: { kind: "orpc" },
      });
      const described = await describeSecret(project.id, input.key);
      return toSummary({ projectId: project.id, slug: input.key, described });
    }),
  remove: os.project.secrets.remove
    .use(projectScopeMiddleware)
    .handler(async ({ context, input }) => {
      const project = requireProjectScope(context);
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: (env as unknown as SecretsRouterEnv).STREAM,
        namespace: project.id,
        path: secretStreamPath(input.id),
      });
      await stream.append({
        type: "events.iterate.com/secret/deleted",
        idempotencyKey: `secret-deleted:${input.id}:${crypto.randomUUID()}`,
        payload: { slug: input.id },
      });
      return { deleted: true };
    }),
};

type DescribedSecret = SecretDescription;

async function describeSecret(projectId: string, slug: string): Promise<DescribedSecret> {
  const stub = await ensureSecretStub({ projectId, slug });
  return (await stub.describe()) as DescribedSecret;
}

function toSummary(input: {
  projectId: string;
  slug: string;
  described: DescribedSecret;
  record?: { createdAt: string; lastWokenAt: string };
}) {
  return {
    id: input.slug,
    key: input.slug,
    metadata: (input.described.metadata ?? {}) as Record<string, unknown>,
    projectId: input.projectId,
    createdAt: input.record?.createdAt ?? "",
    updatedAt: input.record?.lastWokenAt ?? "",
    hasMaterial: input.described.hasMaterial === true || input.described.derivation != null,
  };
}
