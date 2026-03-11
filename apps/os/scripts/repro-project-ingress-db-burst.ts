import { eq, and } from "drizzle-orm";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../backend/db/schema.ts";
import { resolveLocalDockerPostgresPort } from "./local-docker-postgres-port.ts";

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://postgres:postgres@127.0.0.1:${resolveLocalDockerPostgresPort()}/os`;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required. Run with: doppler run -- pnpm tsx scripts/repro-project-ingress-db-burst.ts",
  );
}

const requestCount = Number(process.env.REQUEST_COUNT ?? "100");
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userId = `usr_real_db_${suffix}`;
const organizationId = `org_real_db_${suffix}`;
const membershipId = `member_real_db_${suffix}`;
const projectId = `prj_real_db_${suffix}`;
const slug = `realdb-${suffix}`;
const machineId = `mach_real_db_${suffix}`;

const setupClient = postgres(databaseUrl, { prepare: false });
const setupDb = drizzlePostgresJs(setupClient, { schema, casing: "snake_case" });
const clients: ReturnType<typeof postgres>[] = [];

function createPerRequestDb() {
  const client = postgres(databaseUrl, { prepare: false, max: 3 });
  clients.push(client);
  return drizzlePostgresJs(client, { schema, casing: "snake_case" });
}

async function resolveMachineForIngressUncachedLikeIngress(userId: string, projectSlug: string) {
  const db = createPerRequestDb();

  const rows = await db
    .select({
      projectId: schema.project.id,
      defaultPort: schema.project.defaultPort,
      membershipId: schema.organizationUserMembership.id,
    })
    .from(schema.project)
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .leftJoin(
      schema.organizationUserMembership,
      and(
        eq(schema.organizationUserMembership.organizationId, schema.organization.id),
        eq(schema.organizationUserMembership.userId, userId),
      ),
    )
    .where(eq(schema.project.slug, projectSlug))
    .limit(1);

  const row = rows[0];
  if (!row?.membershipId) {
    throw new Error("Failed to seed ingress repro data");
  }

  await db.query.machine.findFirst({
    where: and(eq(schema.machine.projectId, row.projectId), eq(schema.machine.state, "active")),
  });
}

async function main() {
  console.log(`Seeding repro data for project slug ${slug}`);

  await setupDb.insert(schema.user).values({
    id: userId,
    name: "Real DB Repro",
    email: `${suffix}@iterate.test`,
    role: "user",
  });

  await setupDb.insert(schema.organization).values({
    id: organizationId,
    name: `Real DB Org ${suffix}`,
    slug: `real-db-org-${suffix}`,
  });

  await setupDb.insert(schema.organizationUserMembership).values({
    id: membershipId,
    organizationId,
    userId,
    role: "member",
  });

  await setupDb.insert(schema.project).values({
    id: projectId,
    name: `Real DB Project ${suffix}`,
    slug,
    organizationId,
    sandboxProvider: "docker",
  });

  await setupDb.insert(schema.machine).values({
    id: machineId,
    projectId,
    name: `Real DB Machine ${suffix}`,
    type: "docker",
    state: "active",
    externalId: `ext-${suffix}`,
    metadata: {},
  });

  console.log(`Running ${requestCount} concurrent uncached ingress resolution requests`);

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: requestCount }, () =>
      resolveMachineForIngressUncachedLikeIngress(userId, slug),
    ),
  );

  const rejected = results.filter((result) => result.status === "rejected");
  const fulfilled = results.length - rejected.length;

  console.log(`Completed in ${Date.now() - startedAt}ms`);
  console.log(`Fulfilled: ${fulfilled}`);
  console.log(`Rejected: ${rejected.length}`);

  if (rejected.length > 0) {
    console.log("First rejection:");
    console.dir((rejected[0] as PromiseRejectedResult).reason, { depth: 5 });
  }
}

try {
  await main();
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
  await setupDb.delete(schema.user).where(eq(schema.user.id, userId));
  await setupClient.end();
}
