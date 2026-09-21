import { expect } from "vitest";
import { adminCredentials, readAll, session, until } from "./support/client.ts";
import { fetchProjectUrl, localOnly, projectUrl } from "./support/project-host.ts";

localOnly("website identity, pinned revisions, and explicit publication agree", async () => {
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
    const first = await repo.writeFile("worker.ts", source("Elephants fear the mouse."));
    const second = await repo.writeFile("worker.ts", source("Elephants pack their trunks."));
    // First cold load happens AFTER main advanced: the cache key still loads its exact commit.
    expect(await repo.readFile("worker.ts", { commitOid: first.commitOid })).toBe(
      source("Elephants fear the mouse."),
    );
    const publish = (commitOid: string) =>
      root.append({
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
                  ["readFile", "worker.ts", { commitOid }],
                ],
                cacheKey: commitOid,
              },
            ],
          ],
        },
      });
    await publish(first.commitOid);
    expect((await fetchProjectUrl(apex)).text).toBe("Elephants fear the mouse.");
    await publish(second.commitOid);
    const live = await fetchProjectUrl(apex);
    expect(live.status).toBe(200);
    expect(live.text).toBe("Elephants pack their trunks.");
    expect(
      (await root.subscriptions.list()).filter((s: { name: string }) => s.name === "config"),
    ).toEqual([]);
    expect(await root.rewriteRules.get("itx." + "worker")).toBe(null);
  }
});
