import { expect } from "vitest";
import { adminCredentials, markedSession, readAll, session, until } from "./support/client.ts";
import {
  fetchProjectUrl,
  freshDnsSafeProjectSlug,
  localOnly,
  projectUrl,
} from "./support/project-host.ts";

localOnly(
  "website identity, pinned revisions, a commit publishes, and explicit publication still agrees",
  async () => {
    const slug = freshDnsSafeProjectSlug("website");
    const root = session().authenticate(adminCredentials()).projects.create({ project: slug });
    const identity = await root.cd("/agents/website-test").whoami();
    // the project's URL as the platform composes it — the apex under the worker's routing
    const apex = projectUrl({ project: slug, path: "/" });
    expect(identity).toMatchObject({ projectSlug: slug, projectUrl: apex.href });
    // The project's own saga seeded `/repos/config` (the homepage worker) and published its commit;
    // this story's commits land on top of it (the local worker binds Artifacts for real).
    await until("the project's certificate", async () =>
      (await readAll(root)).find((e) => e.type === "events.iterate.com/project/created"),
    );
    await until("the seed's homepage", async () =>
      (await fetchProjectUrl(apex)).text.trim() === `Homepage of project ${slug}`
        ? true
        : undefined,
    );
    {
      const repo = root.repos.get("/repos/config");
      const source = (joke: string) =>
        `import { IterateConfigEntrypoint } from "iterate/sdk"; export default class extends IterateConfigEntrypoint { fetch() { return new Response(${JSON.stringify(joke)}); } }`;
      // A COMMIT IS THE PUBLICATION: the repo facet cross-posts `repo/commit-completed` to `/`, and the
      // project processor moves `itx.config`, which the apex names, to the new commit
      // (project/processor.ts).
      const first = await repo.writeFile("worker.ts", source("Elephants fear the mouse."));
      await until("the first commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants fear the mouse." ? true : undefined,
      );
      const second = await repo.writeFile("worker.ts", source("Elephants pack their trunks."));
      await until("the second commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants pack their trunks." ? true : undefined,
      );
      // THE WHOLE TREE IS THE WORKER: a commit whose `worker.ts` imports a sibling by its relative
      // path publishes too — the platform's pointer names the repo's modules at the commit, not one
      // file (a `.md` beside them is not a module and changes nothing).
      const third = await repo.commitFiles({
        message: "a site in two modules",
        changes: [
          {
            path: "lib/joke.js",
            content: 'export const joke = "Elephants never forget a module.";\n',
          },
          { path: "NOTES.md", content: "# not a module\n" },
          {
            path: "worker.ts",
            content:
              "import { IterateConfigEntrypoint } from 'iterate/sdk'; import { joke } from './lib/joke.js'; export default class extends IterateConfigEntrypoint { fetch() { return new Response(joke); } }",
          },
        ],
      });
      await until("the two-module commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants never forget a module."
          ? true
          : undefined,
      );
      // One publication per commit on `/`, each as the generation of its commit's fact there, so
      // each later than the last; the pointer names the last.
      const log = await readAll(root);
      const published = log.filter((e) => e.type === "events.iterate.com/project/worker-updated");
      expect(published.map((e) => e.payload.commitOid)).toEqual([
        expect.any(String), // the seed's
        first.commitOid,
        second.commitOid,
        third.commitOid,
      ]);
      const factOffsets = published.map(
        (e) =>
          log.find(
            (fact) =>
              fact.type === "events.iterate.com/repo/commit-completed" &&
              fact.payload.commitOid === e.payload.commitOid,
          )?.offset,
      );
      const generations = published.map((e) => e.payload.generation);
      expect(generations).toEqual(factOffsets);
      expect(generations).toEqual([...new Set(generations)].sort((a, b) => a - b));
      expect((await root.rewriteRules.get("itx.config"))?.target).toContain(third.commitOid);
      // First cold load happens AFTER main advanced: the cache key still loads its exact commit.
      expect(await repo.readFile("worker.ts", { commitOid: first.commitOid })).toBe(
        source("Elephants fear the mouse."),
      );
      // An explicit ingress from the root still works — the apex goes where it is pointed; a commit
      // moves `itx.config`, never the ingress.
      await root.append({
        type: "events.iterate.com/itx/ingress-configured",
        payload: {
          target: [
            "itx",
            "workers",
            [
              "get",
              {
                source: [
                  "itx",
                  "repos",
                  ["get", "/repos/config"],
                  ["readFile", "worker.ts", { commitOid: first.commitOid }],
                ],
                cacheKey: first.commitOid,
              },
            ],
          ],
        },
      });
      const live = await fetchProjectUrl(apex);
      expect(live).toMatchObject({ status: 200, text: "Elephants fear the mouse." });
    }
  },
);

localOnly(
  "a commit made deep in a chain is published at the commit's depth, and the init it sets off runs one deeper: a commit at 7 runs init at 8",
  async () => {
    const slug = freshDnsSafeProjectSlug("deep-commit");
    const root = session().authenticate(adminCredentials()).projects.create({ project: slug });
    await until("the project's certificate", async () =>
      (await readAll(root)).find((e) => e.type === "events.iterate.com/project/created"),
    );
    // Our own code calling the platform back seven hand-offs into a chain (src/cause.ts): the
    // commit is its act, and the publication it sets off keeps the commit's depth.
    const chain = `a deep chain of ${slug}`;
    const deep = markedSession({ chain, depth: 7 })
      .authenticate(adminCredentials())
      .projects.get(slug);
    // A config of its own, whose init says it ran: no module of the default template's is left,
    // so the publication does not wait on the agents package's build.
    const { commitOid } = await deep.repos.get("/repos/config").commitFiles({
      message: "an init that says it ran",
      changes: [
        { path: "agents.ts", delete: true },
        { path: "voice.ts", delete: true },
        {
          path: "worker.ts",
          content: `import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    if (event.type === "events.iterate.com/project/worker-updated")
      await itx.append({ type: "test/init-ran", payload: { generation: event.payload.generation } });
  }
}`,
        },
      ],
    });
    const { published, initRan } = await until("the deep commit's init", async () => {
      const log = await readAll(root);
      const published = log.find(
        (e) =>
          e.type === "events.iterate.com/project/worker-updated" &&
          e.payload.commitOid === commitOid,
      );
      const initRan = log.find(
        (e) => e.type === "test/init-ran" && e.payload.generation === published?.payload.generation,
      );
      return initRan && { published, initRan };
    });
    expect(published.source.cause).toMatchObject({ chain, depth: 7 });
    expect(initRan.source.cause).toMatchObject({ chain, depth: 8 });
  },
);
