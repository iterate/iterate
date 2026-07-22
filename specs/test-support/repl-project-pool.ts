import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { AdminItxSession, ForgedFixtureProject } from "./forged-session.ts";

export type ReplProjectLease = {
  project: ForgedFixtureProject;
  retire(): void;
  [Symbol.dispose](): void;
};

/** One exclusive, lazily-created project slot for each Playwright worker. */
export class ReplProjectPool {
  #leased = false;
  #projectPromise: Promise<ForgedFixtureProject> | undefined;

  constructor(private readonly slugPrefix: string) {}

  async acquire(
    session: AdminItxSession,
    step: <T>(name: string, body: () => Promise<T>) => Promise<T>,
  ): Promise<ReplProjectLease> {
    if (this.#leased) throw new Error("The worker REPL project is already leased.");
    this.#leased = true;
    const current = (this.#projectPromise ??= this.#createProject(session, step));
    let project: ForgedFixtureProject;
    try {
      project = await current;
    } catch (error) {
      this.#leased = false;
      if (this.#projectPromise === current) this.#projectPromise = undefined;
      throw error;
    }

    let released = false;
    let retired = false;
    return {
      project,
      retire() {
        if (released) throw new Error(`Cannot retire released REPL project ${project.id}.`);
        retired = true;
      },
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        this.#leased = false;
        // A failed/timed-out test can leave uncancellable server work behind.
        // Forget the slot before the next test; never overlap it with reuse.
        if (retired && this.#projectPromise === current) this.#projectPromise = undefined;
      },
    };
  }

  async #createProject(
    session: AdminItxSession,
    step: <T>(name: string, body: () => Promise<T>) => Promise<T>,
  ): Promise<ForgedFixtureProject> {
    const slug = uniqueFixtureSlug(this.slugPrefix, { maxPrefixLength: 20 });
    const created = await step("fixture: wait for full project readiness", async () =>
      session.projects.get(slug).create({}, { readiness: "full" }),
    );
    try {
      const identity = await step("fixture: read project identity", () => created.identity());
      console.log(`[repl-project-pool] created ${identity.slug} (${identity.projectId})`);
      return { id: identity.projectId, slug: identity.slug };
    } finally {
      created[Symbol.dispose]();
    }
  }
}
