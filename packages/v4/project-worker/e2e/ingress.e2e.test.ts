// ingress.e2e.test.ts — a project hostname is an authority-bearing route: it selects the project
// from deployment-owned names, then reaches that root context's ordinary `itx.fetch` policy.
import { request as nodeRequest } from "node:http";
import { expect, test } from "vitest";
import { openItx, until, workerUrl } from "./support/client.ts";

const INGRESS_WORKER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class IngressWorker extends WorkerEntrypoint {
  async fetch(request) {
    const itx = await this.env.ITX.get();
    return Response.json({
      projectId: (await itx.whoami()).projectId,
      host: new URL(request.url).host,
    });
  }
}`,
};

function ingressHost(host: string): string {
  const port = new URL(workerUrl("/")).port;
  return port ? `${host}:${port}` : host;
}

function ingressRequest(
  host: string,
  path = "/",
  headers: Record<string, string> = {},
): Promise<Response> {
  // The local workerd harness listens on 127.0.0.1 rather than publishing wildcard localhost DNS.
  // `Host` is nevertheless the HTTP authority it receives, exactly as a wildcard deployment would.
  const url = new URL(workerUrl(path));
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: ingressHost(host) },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers as Record<string, string>,
            }),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function installIngress(projectId: string) {
  const itx = openItx(projectId);
  return itx.provide(
    "itx.fetch",
    `itx.workers.get({ source: ${JSON.stringify(INGRESS_WORKER)} }).fetch`,
  );
}

test("project and custom hostnames select their configured project, not a caller header", async () => {
  await installIngress("prj_ingress_demo");
  await installIngress("prj_ingress_custom");
  await installIngress("prj_ingress_blue");
  await installIngress("prj_ingress_team");

  const platform = await ingressRequest("demo.localhost", "/notes/one", {
    "x-itx-project-id": "prj_ingress_custom",
    "x-itx-expression": "itx.whoami",
  });
  expect(platform.status, await platform.clone().text()).toBe(200);
  expect(await platform.json()).toEqual({
    projectId: "prj_ingress_demo",
    host: ingressHost("demo.localhost"),
  });

  // The project host is evaluated before the platform's `/api` entrypoint. It therefore cannot
  // turn a browser request into an unauthenticated project catalog.
  const api = await ingressRequest("demo.localhost", "/api");
  expect(await api.json()).toMatchObject({ projectId: "prj_ingress_demo" });

  const app = await ingressRequest("editor-demo.localhost");
  expect(await app.json()).toMatchObject({ projectId: "prj_ingress_demo" });

  const custom = await ingressRequest("custom.localhost");
  expect(await custom.json()).toMatchObject({ projectId: "prj_ingress_custom" });

  const customApp = await ingressRequest("editor.custom.localhost");
  expect(await customApp.json()).toMatchObject({ projectId: "prj_ingress_custom" });

  // A complete slug is allowed to contain hyphens. The resolver chooses the longest configured
  // suffix, and recognizes both the current single-hyphen and OS's older double-hyphen spelling.
  const longest = await ingressRequest("editor-blue-team.localhost");
  expect(await longest.json()).toMatchObject({ projectId: "prj_ingress_blue" });
  const doubleHyphen = await ingressRequest("editor--blue-team.localhost");
  expect(await doubleHyphen.json()).toMatchObject({ projectId: "prj_ingress_blue" });
});

test("an unregistered project host is not the dashboard fallback", async () => {
  const response = await ingressRequest("missing.localhost");
  expect(response.status).toBe(421);
  expect(await response.text()).not.toContain("project-worker —");
});

test("a configured project host whose itx.fetch rule was removed refuses its own physical egress", async () => {
  const projectId = "prj_ingress_demo";
  const installed = await installIngress(projectId);
  const itx = openItx(projectId);
  expect((await ingressRequest("demo.localhost", "/installed-router")).status).toBe(200);
  installed[Symbol.dispose]();
  await until("the disposed fetch rule reveals physical egress", async () =>
    (await itx.rewriteRules.get("itx.fetch"))?.origin === "platform" ? true : undefined,
  );

  const response = await ingressRequest("demo.localhost", "/unconfigured-egress");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ code: "PROJECT_FETCH_NOT_CONFIGURED" });
});
