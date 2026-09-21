import { expect } from "vitest";
import { adminCredentials, session } from "./support/client.ts";
import { FakeArtifacts } from "./support/fake-artifacts.ts";
import { localOnly, fetchProjectHost, ingressHostname } from "./support/project-host.ts";

localOnly("website identity, pinned revisions, and explicit publication agree", async () => {
  const slug = `website-${Date.now()}`;
  const root = session().authenticate(adminCredentials()).projects.create({ project: slug });
  const identity = await root.cd("/agents/website-test").whoami();
  expect(identity.projectSlug).toBe(slug);
  // the project's URL under the platform's own protocol and port (http and a port on the local
  // harness), an href
  const platform = new URL(process.env.WORKER_BASE_URL!);
  expect(identity.projectUrl).toBe(
    `${platform.protocol}//${slug}.${ingressHostname()}${platform.port ? `:${platform.port}` : ""}/`,
  );
  const artifacts = await FakeArtifacts.start();
  try {
    await root.cd("/repos/config").provide("itx.cfArtifacts", artifacts);
    await root.repos.create("/repos/config"); // born through the collection; the handle addresses it
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
    expect((await fetchProjectHost(`${slug}.${ingressHostname()}`, "/")).text).toBe(
      "Elephants fear the mouse.",
    );
    await publish(second.commitOid);
    const live = await fetchProjectHost(`${slug}.${ingressHostname()}`, "/");
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
