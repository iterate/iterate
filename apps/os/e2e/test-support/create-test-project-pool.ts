import type { RpcStub } from "capnweb";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { Session } from "../../src/itx-api.generated.ts";

type ProjectPoolState = {
  availableSlots: ProjectSlot[];
  waiters: Array<(slot: ProjectSlot) => void>;
};

export type TestProjectLease = {
  projectId: string;
  /** Permanently remove this project from the reusable pool when the lease ends. */
  retire(): void;
  [Symbol.dispose](): void;
};

type ProjectSlot = {
  getProjectId(session: RpcStub<Session>): Promise<string>;
  retireProject(): void;
};

/**
 * Lazily create a bounded family of projects, then exclusively lease one to
 * each in-flight test. Callers may reuse a project only when all mutable
 * resources are isolated within the lease. Project-birth and isolation tests
 * must continue to create fresh projects.
 */
export function createTestProjectPool(opts: { size: number; slugPrefix: string }) {
  if (!Number.isInteger(opts.size) || opts.size < 1) {
    throw new Error(`Project pool size must be a positive integer; received ${opts.size}.`);
  }

  let statePromise: Promise<ProjectPoolState> | undefined;
  const slots = Array.from({ length: opts.size }, (_, index) =>
    createProjectSlot(`${opts.slugPrefix}-${index + 1}`),
  );

  return {
    async acquire(session: RpcStub<Session>): Promise<TestProjectLease> {
      const current = (statePromise ??= createPoolState(session, slots));
      let state: ProjectPoolState;
      try {
        state = await current;
      } catch (error) {
        if (statePromise === current) statePromise = undefined;
        throw error;
      }

      const slot = await checkout(state);
      let projectId: string;
      try {
        projectId = await slot.getProjectId(session);
      } catch (error) {
        releaseSlot(state, slot);
        throw error;
      }

      let released = false;
      let retired = false;
      return {
        projectId,
        retire() {
          if (released) throw new Error(`Cannot retire released project lease ${projectId}.`);
          retired = true;
        },
        [Symbol.dispose]() {
          if (released) return;
          released = true;
          // A timed-out RPC cannot be cancelled reliably once it reached the
          // server. Forget the old id before making this slot available so
          // late work can never overlap a later test on the same project.
          if (retired) slot.retireProject();
          releaseSlot(state, slot);
        },
      };
    },
  };
}

function createProjectSlot(slugPrefix: string): ProjectSlot {
  let projectIdPromise: Promise<string> | undefined;
  return {
    async getProjectId(session) {
      const current = (projectIdPromise ??= createProject(session, slugPrefix));
      try {
        return await current;
      } catch (error) {
        if (projectIdPromise === current) projectIdPromise = undefined;
        throw error;
      }
    },
    retireProject() {
      projectIdPromise = undefined;
    },
  };
}

async function createPoolState(
  session: RpcStub<Session>,
  slots: ProjectSlot[],
): Promise<ProjectPoolState> {
  // Each slot memoizes independently. If one birth fails, the next acquire
  // retries only that slot instead of losing successful project IDs.
  await Promise.all(slots.map((slot) => slot.getProjectId(session)));
  return { availableSlots: [...slots], waiters: [] };
}

function checkout(state: ProjectPoolState): Promise<ProjectSlot> {
  const slot = state.availableSlots.pop();
  if (slot) return Promise.resolve(slot);
  return new Promise((resolve) => state.waiters.push(resolve));
}

function releaseSlot(state: ProjectPoolState, slot: ProjectSlot): void {
  const waiter = state.waiters.shift();
  if (waiter) waiter(slot);
  else state.availableSlots.push(slot);
}

async function createProject(session: RpcStub<Session>, slugPrefix: string): Promise<string> {
  const slug = uniqueFixtureSlug(slugPrefix, { maxPrefixLength: 20 });
  using project = session.projects.create({ slug });
  const { projectId } = await project.__describe();
  console.log(`[project-pool] created ${slug} (${projectId})`);
  return projectId;
}
