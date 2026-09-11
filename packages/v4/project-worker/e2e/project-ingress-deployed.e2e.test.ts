// A user-space project-ingress proof. The local row proves the public ITX installation shape; the
// guarded row is deliberately inert until a dedicated deployed project and hostname are provisioned.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { expect, test } from "vitest";
import { expressionUrl, freshCtx, openItx, session } from "./support/client.ts";

const routerSource = (
  await transform(
    await readFile(
      fileURLToPath(new URL("../examples/docs/router.ts", import.meta.url).href),
      "utf8",
    ),
    { loader: "ts", format: "esm", target: "es2022" },
  )
).code;

const docsSource = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class DocsApp extends WorkerEntrypoint {
  fetch(request) {
    return new Response("docs:" + new URL(request.url).pathname, {
      headers: { "x-docs-router": "user-space" },
    });
  }
}`,
};

async function installRouter(itx: any): Promise<void> {
  await itx.append(
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      idempotencyKey: `docs-router:${crypto.randomUUID()}`,
      payload: {
        match: "itx.docs",
        target: `itx.workers.get({ source: ${JSON.stringify(docsSource)} })`,
      },
    },
    {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      idempotencyKey: `docs-router:${crypto.randomUUID()}`,
      payload: {
        match: "itx.fetch",
        target: `itx.workers.get({ source: ${JSON.stringify({ "cap.js": routerSource })} }).fetch`,
      },
    },
  );
}

test("durable Docs router and actor survive the installer session closing", async () => {
  const projectId = freshCtx("docs-ingress-router");
  const installer = session();
  await installRouter(installer.authenticate().projects.get(projectId));
  installer[Symbol.dispose]();

  // A new client finds the durable `itx.fetch` and `itx.docs` facts; neither was a live stub
  // attached to the installer session.
  const itx = openItx(projectId);

  const response = await itx.fetch(
    new Request("https://docs--v4-demo.iterate2.app/guide/getting-started"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-docs-router")).toBe("user-space");
  expect(await response.text()).toBe("docs:/guide/getting-started");

  // The HTTP expression door independently resolves the same raw `itx.docs` fact.
  const docs = await fetch(expressionUrl(projectId, "itx.docs"));
  expect(docs.status).toBe(200);
  expect(docs.headers.get("x-docs-router")).toBe("user-space");
  expect(await docs.text()).toBe("docs:/expression");
});

const deployedIngressProof = process.env.PROJECT_INGRESS_PROOF === "1" ? test : test.skip;

deployedIngressProof(
  "deployed ingress reaches itx.docs after authenticated public ITX installs the router",
  async () => {
    const projectId = process.env.PROJECT_INGRESS_PROJECT_ID;
    const hostname = process.env.PROJECT_INGRESS_HOST;
    const expectedBody = process.env.PROJECT_INGRESS_EXPECTED_BODY;
    if (!projectId || !hostname || expectedBody === undefined)
      throw new Error(
        "PROJECT_INGRESS_PROOF=1 needs PROJECT_INGRESS_PROJECT_ID, PROJECT_INGRESS_HOST, and PROJECT_INGRESS_EXPECTED_BODY",
      );

    // Normally this only proves the already-installed deployed router: never overwrite a user's
    // Docs rules as a side effect of a smoke. A dedicated empty project may opt into installation.
    if (process.env.PROJECT_INGRESS_INSTALL_ROUTER === "1") await installRouter(openItx(projectId));
    const response = await fetch(`https://${hostname}${process.env.PROJECT_INGRESS_PATH ?? "/"}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain(expectedBody);
  },
  60_000,
);

deployedIngressProof(
  "an unconfigured context refuses physical egress to its own deployed project host",
  async () => {
    const projectId = process.env.PROJECT_INGRESS_PROJECT_ID;
    const hostname = process.env.PROJECT_INGRESS_HOST;
    if (!projectId || !hostname)
      throw new Error(
        "PROJECT_INGRESS_PROOF=1 needs PROJECT_INGRESS_PROJECT_ID and PROJECT_INGRESS_HOST",
      );

    // Do not remove the published demo's router to stage this refusal. A fresh leaf in that same
    // project has the default physical fetch policy and the same authoritative hostname directory.
    const itx = openItx(projectId).cd(`/_proof/unconfigured-ingress-${crypto.randomUUID()}`);
    const response = await itx.fetch(new Request(`https://${hostname}/unconfigured-egress`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "PROJECT_FETCH_NOT_CONFIGURED" });
  },
  60_000,
);
