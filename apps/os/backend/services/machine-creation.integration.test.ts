import { beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { typeid } from "typeid-js";
import type { CloudflareEnv } from "../../env.ts";
import * as schema from "../db/schema.ts";

const { createRuntimeMock } = vi.hoisted(() => ({
  createRuntimeMock: vi.fn(),
}));

vi.mock("@iterate-com/sandbox/providers/machine-runtime", () => ({
  createMachineRuntime: vi.fn(async () => ({
    create: createRuntimeMock,
  })),
}));

vi.mock("../../env.ts", () => ({
  env: {
    ENCRYPTION_SECRET: "integration-test-secret",
  },
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    promise.catch(() => {});
  }),
}));

import { createMachineForProject } from "./machine-creation.ts";

const getTestDb = () => {
  const connectionString =
    process.env.DATABASE_URL ?? process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or DRIZZLE_RW_POSTGRES_CONNECTION_STRING is required for integration tests.",
    );
  }
  const client = postgres(connectionString, { prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
};

describe("machine creation integration", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    try {
      db = getTestDb();
      await db.execute(sql`select 1`);
    } catch {
      return;
    }
  });

  test("enqueues deferred readiness probe when daemon reports ready before externalId exists", async () => {
    if (!db) return;

    // Why this test exists:
    // The daemon can report "ready" before provider provisioning finishes.
    // In that window, externalId is still empty, so reportStatus cannot enqueue
    // machine:verify-readiness yet. We must enqueue it later during provisioning
    // completion, otherwise the machine can get stuck in starting/verifying forever.

    const orgId = typeid("org").toString();
    const projectId = typeid("prj").toString();
    const now = Date.now();
    const orgSlug = `it-org-${now}`;
    const projectSlug = `it-proj-${now}`;

    await db.insert(schema.organization).values({
      id: orgId,
      name: "Integration Org",
      slug: orgSlug,
    });

    await db.insert(schema.project).values({
      id: projectId,
      name: "Integration Project",
      slug: projectSlug,
      organizationId: orgId,
      sandboxProvider: "daytona",
    });

    let releaseProvisioning: () => void = () => {};
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });

    createRuntimeMock.mockReset();
    createRuntimeMock.mockImplementationOnce(async () => {
      await provisioningGate;
      return {
        externalId: `ext-${now}`,
        metadata: { provider: "mock-daytona" },
      };
    });

    const env = {
      VITE_PUBLIC_URL: "https://os.example.test",
      DANGEROUS_RAW_SECRETS_ENABLED: "false",
    } as unknown as CloudflareEnv;

    const { machine, provisionPromise } = await createMachineForProject({
      db,
      env,
      projectId,
      organizationId: orgId,
      organizationSlug: orgSlug,
      projectSlug,
      name: "race-machine",
    });

    expect(provisionPromise).toBeTruthy();

    // Simulate the reportStatus path having already set daemonStatus=verifying
    // while externalId is still empty.
    await db
      .update(schema.machine)
      .set({
        metadata: {
          daemonStatus: "verifying",
          daemonStatusMessage: "Running readiness probe...",
          daemonReadyAt: null,
        },
      })
      .where(eq(schema.machine.id, machine.id));

    releaseProvisioning();
    await provisionPromise;

    const updatedMachine = await db.query.machine.findFirst({
      where: eq(schema.machine.id, machine.id),
    });

    expect(updatedMachine?.externalId).toBe(`ext-${now}`);
    expect(updatedMachine?.state).toBe("starting");
    expect(updatedMachine?.metadata).toMatchObject({
      daemonStatus: "verifying",
    });

    const readinessEvents = await db.query.outboxEvent.findMany({
      where: and(
        eq(schema.outboxEvent.name, "machine:verify-readiness"),
        sql`${schema.outboxEvent.payload}->>'machineId' = ${machine.id}`,
      ),
    });

    // Exactly one event proves the deferred enqueue path ran once and did not
    // duplicate the readiness probe event.
    expect(readinessEvents).toHaveLength(1);
    expect(readinessEvents[0]?.payload).toMatchObject({
      machineId: machine.id,
      projectId,
    });
  });
});
