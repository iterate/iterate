import { expect } from "vitest";
import { adminCredentials, session } from "./support/client.ts";
import { FakeArtifacts } from "./support/fake-artifacts.ts";
import {
  localOnly,
  fetchProjectHost,
  freshDnsSafeProjectSlug,
  projectHostnameBase,
} from "./support/project-host.ts";

localOnly("website identity, pinned revisions, and explicit publication agree", async () => {
  const slug = freshDnsSafeProjectSlug("website");
  const root = session().authenticate(adminCredentials()).projects.create({ project: slug });
  const identity = await root.cd("/agents/website-test").whoami();
  expect(identity.projectSlug).toBe(slug);
  expect(identity.projectUrl).toBe(`https://${slug}.${projectHostnameBase()}`);
  const artifacts = await FakeArtifacts.start();
  try {
    await root.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
    const repo = root.repos.get("/repos/config");
    await repo.create();
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
    expect((await fetchProjectHost(`${slug}.${projectHostnameBase()}`, "/")).text).toBe(
      "Elephants fear the mouse.",
    );
    await publish(second.commitOid);
    const live = await fetchProjectHost(`${slug}.${projectHostnameBase()}`, "/");
    expect(live.status).toBe(200);
    expect(live.text).toBe("Elephants pack their trunks.");
    expect(
      (await root.subscriptions.list()).filter((s: { name: string }) => s.name === "config"),
    ).toEqual([]);
    expect(await root.rewriteRules.get("itx." + "worker")).toBe(null);
  } finally {
    await artifacts.close();
  }
});
