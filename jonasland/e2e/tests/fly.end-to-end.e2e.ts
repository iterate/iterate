import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { describe, expect, test } from "vitest";
import { projectDeployment } from "../test-helpers/index.ts";
import type { RegistryClient } from "../../../services/registry-service/src/client.ts";
import type { ProjectDeployment } from "../test-helpers/project-deployment.ts";

const RUN_E2E = process.env.RUN_JONASLAND_E2E === "true";
const E2E_PROVIDER = (process.env.JONASLAND_E2E_PROVIDER ?? "docker").trim().toLowerCase();
const RUN_FLY_E2E = RUN_E2E && E2E_PROVIDER === "fly";

const image =
  process.env.JONASLAND_E2E_FLY_IMAGE ??
  process.env.FLY_DEFAULT_IMAGE ??
  process.env.JONASLAND_SANDBOX_IMAGE ??
  "";

async function fetchWithRetry(url: string, timeoutMs = 30_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`timed out fetching ${url}`, { cause: lastError });
}

async function getPublicURLWithRetry(params: {
  registry: RegistryClient;
  internalURL: string;
  timeoutMs?: number;
}): Promise<{ publicURL: string }> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await params.registry.getPublicURL({
        internalURL: params.internalURL,
      });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out resolving public URL for ${params.internalURL}`, { cause: lastError });
}

async function getPublicURLViaExecWithRetry(params: {
  deployment: ProjectDeployment;
  internalURL: string;
  timeoutMs?: number;
}): Promise<{ publicURL: string }> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const escapedUrl = JSON.stringify(params.internalURL);

  while (Date.now() < deadline) {
    const response = await params.deployment
      .exec(
        `curl -fsS -X POST -H 'Host: registry.iterate.localhost' -H 'Content-Type: application/json' --data '{"json":{"internalURL":${escapedUrl}}}' http://127.0.0.1/orpc/getPublicURL`,
      )
      .catch((error) => {
        lastError = error;
        return { exitCode: 1, output: "" };
      });

    if (response.exitCode === 0) {
      try {
        const payload = JSON.parse(response.output) as { json?: { publicURL?: string } };
        const publicURL = payload.json?.publicURL;
        if (typeof publicURL === "string" && publicURL.length > 0) {
          return { publicURL };
        }
      } catch (error) {
        lastError = error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out resolving public URL via exec for ${params.internalURL}`, {
    cause: lastError,
  });
}

async function fetchViaFlyIngressHostHeader(params: {
  deployment: ProjectDeployment;
  publicURL: string;
}): Promise<Response> {
  const ingress = await params.deployment.ingressUrl();
  const ingressUrl = new URL(ingress);
  if (ingressUrl.protocol === "https:") {
    ingressUrl.protocol = "http:";
  }
  const targetUrl = new URL(params.publicURL);
  const requestUrl = new URL(`${targetUrl.pathname}${targetUrl.search}`, ingressUrl);
  const requestImpl = requestUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = requestImpl(
      requestUrl,
      {
        method: "GET",
        headers: {
          host: targetUrl.host,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
              continue;
            }
            responseHeaders.set(key, String(value));
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchViaFlyIngressHostHeaderWithRetry(params: {
  deployment: ProjectDeployment;
  publicURL: string;
  timeoutMs?: number;
}): Promise<Response> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await fetchViaFlyIngressHostHeader(params);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out fetching via Fly ingress for ${params.publicURL}`, {
    cause: lastError,
  });
}

async function fetchViaMachineLoopbackHostHeaderWithRetry(params: {
  deployment: ProjectDeployment;
  publicURL: string;
  timeoutMs?: number;
}): Promise<Response> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  const parsed = new URL(params.publicURL);
  const path = `${parsed.pathname}${parsed.search}`;

  while (Date.now() < deadline) {
    const response = await params.deployment
      .exec(`curl -fsS -H 'Host: ${parsed.host}' http://127.0.0.1${path}`)
      .catch((error) => {
        lastError = error;
        return { exitCode: 1, output: "" };
      });

    if (response.exitCode === 0) {
      return new Response(response.output, { status: 200 });
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`timed out fetching via machine loopback for ${params.publicURL}`, {
    cause: lastError,
  });
}

describe.runIf(RUN_FLY_E2E)("jonasland fly e2e", () => {
  test("boots Fly machine and resolves public URL through registry", async () => {
    if (image.trim().length === 0) {
      throw new Error("Set JONASLAND_E2E_FLY_IMAGE or FLY_DEFAULT_IMAGE for Fly e2e");
    }

    let step = "create deployment";
    try {
      await using deployment = await projectDeployment({
        image,
        name: `jonasland-e2e-fly-${randomUUID().slice(0, 8)}`,
      });

      step = "resolve ingress";
      const ingress = await deployment.ingressUrl();

      step = "wait for ingress healthy";
      await deployment.waitForHealthyWithLogs({ url: `${ingress}/healthz` });

      step = "resolve public events health URL";
      const publicEventsHealth =
        E2E_PROVIDER === "fly"
          ? await getPublicURLViaExecWithRetry({
              deployment,
              internalURL: "http://events.iterate.localhost/orpc/service/health",
              timeoutMs: 120_000,
            })
          : await getPublicURLWithRetry({
              registry: deployment.registry,
              internalURL: "http://events.iterate.localhost/orpc/service/health",
              timeoutMs: 120_000,
            });

      step = "fetch public events health";
      const response =
        E2E_PROVIDER === "fly"
          ? await fetchViaFlyIngressHostHeaderWithRetry({
              deployment,
              publicURL: publicEventsHealth.publicURL,
              timeoutMs: 45_000,
            }).catch(
              async () =>
                await fetchViaMachineLoopbackHostHeaderWithRetry({
                  deployment,
                  publicURL: publicEventsHealth.publicURL,
                  timeoutMs: 45_000,
                }),
            )
          : await fetchWithRetry(publicEventsHealth.publicURL, 45_000);
      const body = await response.text();

      expect(response.ok).toBe(true);
      expect(body).toContain('"ok":true');
    } catch (error) {
      throw new Error(`fly e2e failed during: ${step}`, { cause: error });
    }
  }, 600_000);
});
