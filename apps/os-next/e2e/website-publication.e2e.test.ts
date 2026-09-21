import { expect } from "vitest";
import { adminCredentials, readAll, session, until } from "./support/client.ts";
import { fetchProjectUrl, localOnly, projectUrl } from "./support/project-host.ts";

localOnly(
  "website identity, pinned revisions, a commit publishes, and explicit publication still agrees",
  async () => {
    const slug = `website-${Date.now()}`;
    const root = session().authenticate(adminCredentials()).projects.create({ project: slug });
    const identity = await root.cd("/agents/website-test").whoami();
    expect(identity.projectSlug).toBe(slug);
    // the project's URL as the platform composes it — the apex under the worker's routing
    const apex = projectUrl({ project: slug, path: "/" });
    expect(identity.projectUrl).toBe(apex.href);
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
      // project processor points the apex at the new commit (project/processor.ts) — the agent's job
      // used to end with an append on `/` it cannot make from its sandbox; now it ends with the commit.
      const first = await repo.writeFile("worker.ts", source("Elephants fear the mouse."));
      await until("the first commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants fear the mouse." ? true : undefined,
      );
      const second = await repo.writeFile("worker.ts", source("Elephants pack their trunks."));
      await until("the second commit published", async () =>
        (await fetchProjectUrl(apex)).text === "Elephants pack their trunks." ? true : undefined,
      );
      // The processor's ingress facts are keyed by the commit: exactly one per commit on `/`.
      const published = (await readAll(root)).filter(
        (e) => e.type === "events.iterate.com/project/ingress-configured",
      );
      expect(published.map((e) => e.payload.target[2][1].cacheKey)).toEqual([
        expect.any(String), // the seed's
        first.commitOid,
        second.commitOid,
      ]);
      // First cold load happens AFTER main advanced: the cache key still loads its exact commit.
      expect(await repo.readFile("worker.ts", { commitOid: first.commitOid })).toBe(
        source("Elephants fear the mouse."),
      );
      // An explicit publication from the root still works — the apex goes where it is pointed, until
      // the next commit moves it again.
      await root.append({
        type: "events.iterate.com/project/ingress-configured",
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
      expect(live.status).toBe(200);
      expect(live.text).toBe("Elephants fear the mouse.");
      expect(
        (await root.subscriptions.list()).filter((s: { name: string }) => s.name === "config"),
      ).toEqual([]);
      expect(await root.rewriteRules.get("itx." + "worker")).toBe(null);
    }
  },
);
