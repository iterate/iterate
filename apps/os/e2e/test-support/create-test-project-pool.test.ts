import type { RpcStub } from "capnweb";
import { expect, test } from "vitest";
import type { Session } from "../../src/itx-api.generated.ts";
import { createTestProjectPool } from "./create-test-project-pool.ts";

test("released leases reuse the same project", async () => {
  const { createdProjectIds, session } = createSessionStub();
  const pool = createTestProjectPool({ size: 1, slugPrefix: "pool-reuse" });

  const first = await pool.acquire(session);
  first[Symbol.dispose]();
  const second = await pool.acquire(session);

  expect(second).toMatchObject({ projectId: first.projectId });
  expect(createdProjectIds).toHaveLength(1);
  second[Symbol.dispose]();
});

test("retired leases are replaced before the slot is reused", async () => {
  const { createdProjectIds, session } = createSessionStub();
  const pool = createTestProjectPool({ size: 1, slugPrefix: "pool-retire" });

  const timedOut = await pool.acquire(session);
  timedOut.retire();
  timedOut[Symbol.dispose]();
  const replacement = await pool.acquire(session);

  expect(replacement).not.toMatchObject({ projectId: timedOut.projectId });
  expect(createdProjectIds).toEqual([timedOut.projectId, replacement.projectId]);
  replacement[Symbol.dispose]();
});

function createSessionStub() {
  const createdProjectIds: string[] = [];
  const session = {
    projects: {
      create: () => {
        const projectId = `project-${createdProjectIds.length + 1}`;
        createdProjectIds.push(projectId);
        return {
          async __describe() {
            return { projectId };
          },
          [Symbol.dispose]() {},
        };
      },
    },
  } as unknown as RpcStub<Session>;
  return { createdProjectIds, session };
}
