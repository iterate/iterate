import type { RpcStub } from "capnweb";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { Session } from "../../src/itx-api.generated.ts";

type ProjectPoolState = {
  availableProjectIds: string[];
  waiters: Array<(projectId: string) => void>;
};

export type TestProjectLease = {
  projectId: string;
  [Symbol.dispose](): void;
};

/**
 * Lazily create one project for an isolation-safe test family in this Vitest
 * worker, then vend a fresh capability handle to that project for each test.
 *
 * Callers must give every mutable resource (stream path, capability mount,
 * repository path, agent path, and so on) a per-test identity. Project birth
 * and project isolation tests must continue to create fresh projects instead.
 * A failed birth is never memoized, so a retry can provision a replacement.
 */
export function createSharedTestProjectId(opts: { slugPrefix: string }) {
  let projectIdPromise: Promise<string> | undefined;

  return async function getSharedTestProjectId(session: RpcStub<Session>): Promise<string> {
    const current = (projectIdPromise ??= createProject(session, opts.slugPrefix));
    try {
      return await current;
    } catch (error) {
      if (projectIdPromise === current) projectIdPromise = undefined;
      throw error;
    }
  };
}

/**
 * Pre-create a bounded family of reusable projects and exclusively lease one
 * to each in-flight test. Set `size` to the file's test concurrency so reuse
 * does not serialize otherwise-independent tests. As with the single-project
 * helper above, callers must use per-test resource identities and keep tests
 * whose subject is project birth/isolation on fresh projects.
 */
export function createTestProjectPool(opts: { size: number; slugPrefix: string }) {
  if (!Number.isInteger(opts.size) || opts.size < 1) {
    throw new Error(`Project pool size must be a positive integer; received ${opts.size}.`);
  }

  let statePromise: Promise<ProjectPoolState> | undefined;
  const getProjectIds = Array.from({ length: opts.size }, (_, index) =>
    createSharedTestProjectId({ slugPrefix: `${opts.slugPrefix}-${index + 1}` }),
  );

  return {
    async acquire(session: RpcStub<Session>): Promise<TestProjectLease> {
      const current = (statePromise ??= createPoolState(session, getProjectIds));
      let state: ProjectPoolState;
      try {
        state = await current;
      } catch (error) {
        if (statePromise === current) statePromise = undefined;
        throw error;
      }

      const projectId = await checkout(state);
      let released = false;
      return {
        projectId,
        [Symbol.dispose]() {
          if (released) return;
          released = true;
          const waiter = state.waiters.shift();
          if (waiter) waiter(projectId);
          else state.availableProjectIds.push(projectId);
        },
      };
    },
  };
}

async function createPoolState(
  session: RpcStub<Session>,
  getProjectIds: Array<(session: RpcStub<Session>) => Promise<string>>,
): Promise<ProjectPoolState> {
  // Each slot memoizes independently. If one birth fails, the next acquire
  // retries only that slot instead of losing the successful project IDs.
  const projectIds = await Promise.all(getProjectIds.map((getProjectId) => getProjectId(session)));
  return { availableProjectIds: projectIds, waiters: [] };
}

function checkout(state: ProjectPoolState): Promise<string> {
  const projectId = state.availableProjectIds.pop();
  if (projectId) return Promise.resolve(projectId);
  return new Promise((resolve) => state.waiters.push(resolve));
}

async function createProject(session: RpcStub<Session>, slugPrefix: string): Promise<string> {
  const slug = uniqueFixtureSlug(slugPrefix, { maxPrefixLength: 20 });
  using project = session.projects.create({ slug });
  const { projectId } = await project.__describe();
  console.log(`[project-reuse] created family project ${slug} (${projectId})`);
  return projectId;
}
