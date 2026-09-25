import { expect } from "vitest";
import { adminCredentials, readAll, session, until } from "./support/client.ts";
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
    expect((await fetchProjectUrl(apex)).text.trim()).toBe(`Homepage of project ${slug}`);
    {
      const repo = root.repos.get("/repos/config");
      const source = (joke: string) =>
        `import { WorkerEntrypoint } from 'cloudflare:workers'; export default class extends WorkerEntrypoint { fetch() { return new Response(${JSON.stringify(joke)}); } }`;
      // A COMMIT IS THE PUBLICATION: the repo facet cross-posts `repo/commit-completed` to `/`, and the
      // project processor points the apex at the new commit (project/processor.ts).
      const first = await repo.writeFile("worker.ts", source("Elephants fear the mouse."));
      await until("the first commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants fear the mouse." ? true : undefined,
      );
      const second = await repo.writeFile("worker.ts", source("Elephants pack their trunks."));
      await until("the second commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants pack their trunks." ? true : undefined,
      );
      // THE WHOLE TREE IS THE WORKER: a commit whose `worker.ts` imports a sibling by its relative
      // path publishes too — the platform's target is the repo's modules at the commit, not one file
      // (a `.md` beside them is not a module and changes nothing).
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
              "import { WorkerEntrypoint } from 'cloudflare:workers'; import { joke } from './lib/joke.js'; export default class extends WorkerEntrypoint { fetch() { return new Response(joke); } }",
          },
        ],
      });
      await until("the two-module commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants never forget a module."
          ? true
          : undefined,
      );
      // The processor's ingress facts are keyed by the commit: exactly one per commit on `/`, each
      // loading the repo's modules at that commit.
      const published = (await readAll(root)).filter(
        (e) => e.type === "events.iterate.com/itx/ingress-configured",
      );
      expect(published.map((e) => e.payload.target[2][1].cacheKey)).toEqual([
        expect.any(String), // the seed's
        first.commitOid,
        second.commitOid,
        third.commitOid,
      ]);
      expect(published.at(-1)!.payload.target[2][1]).toMatchObject({
        source: [
          "itx",
          "repos",
          ["get", "/repos/config"],
          ["modules", { commitOid: third.commitOid }],
        ],
      });
      // First cold load happens AFTER main advanced: the cache key still loads its exact commit.
      expect(await repo.readFile("worker.ts", { commitOid: first.commitOid })).toBe(
        source("Elephants fear the mouse."),
      );
      // An explicit publication from the root still works — the apex goes where it is pointed, until
      // the next commit moves it again.
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
