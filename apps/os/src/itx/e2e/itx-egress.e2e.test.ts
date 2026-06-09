// Egress: one pipe, two doors (Law 5), proven against a real deployment.
//
//   explicit door  itx.fetch(...) — available to every handle holder,
//                  including this Node process (tier 3: hardware we don't load)
//   implicit door  bare fetch() inside isolates the platform loads —
//                  /api/itx/run scripts and worker caps get ProjectEgress as
//                  their globalOutbound, so even a dependency's fetch goes
//                  through secret substitution without knowing it
//
// Every project is born with the example secret (example.egress_api_key →
// "example-secret-value"), and the worker exposes an authenticated echo
// endpoint, so we can assert the substitution end to end: the isolate sends
// a getSecret(...) placeholder and the echo sees the material.

import { expect, test } from "vitest";
import { connectItx, type ItxClient } from "../client.ts";

const SECRET_KEY = "example.egress_api_key";
const SECRET_MATERIAL = "example-secret-value";
const HEADER = "x-itx-egress-probe";

test("itx.fetch substitutes secrets through project egress (explicit door)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-egress-${suffix()}` })) as { id: string };
  using projectItx = await itx.projects.get(project.id);

  const response = await projectItx.fetch(echoUrl(), {
    headers: {
      authorization: `Bearer ${adminApiSecret()}`,
      [HEADER]: secretReference(),
    },
  });
  expect(response.status).toBe(200);
  expect(echoedHeader(await response.json())).toContain(SECRET_MATERIAL);
});

test("bare fetch() in a project itx script goes through egress (implicit door)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-egress-run-${suffix()}` })) as {
    id: string;
  };

  // The script calls PLAIN fetch — no itx involvement. globalOutbound does
  // the rest because the run harness loaded it that way.
  const response = await fetch(new URL("/api/itx/run", baseUrl()), {
    body: JSON.stringify({
      context: project.id,
      functionSource: `async ({ vars }) => {
        const response = await fetch(vars.echoUrl, {
          headers: { authorization: vars.echoAuth, [vars.header]: vars.secretReference },
        });
        return { body: await response.json(), status: response.status };
      }`,
      vars: {
        echoAuth: `Bearer ${adminApiSecret()}`,
        echoUrl: echoUrl(),
        header: HEADER,
        secretReference: secretReference(),
      },
    }),
    headers: { authorization: `Bearer ${adminApiSecret()}`, "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { result: { body: unknown; status: number } };
  expect(response.status).toBe(200);
  expect(body.result.status).toBe(200);
  expect(echoedHeader(body.result.body)).toContain(SECRET_MATERIAL);
});

test("bare fetch() inside a worker cap goes through egress (implicit door)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-egress-cap-${suffix()}` })) as {
    id: string;
  };
  using projectItx = await itx.projects.get(project.id);

  await projectItx.caps.define({
    name: "egressProbe",
    source: {
      codeId: crypto.randomUUID(),
      mainModule: "cap.js",
      modules: {
        "cap.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";
          export default class extends WorkerEntrypoint {
            async probe({ echoUrl, echoAuth, header, secretReference }) {
              const response = await fetch(echoUrl, {
                headers: { authorization: echoAuth, [header]: secretReference },
              });
              return { body: await response.json(), status: response.status };
            }
          }
        `,
      },
    },
  });

  const probe = (await (projectItx as never as Record<string, any>).egressProbe.probe({
    echoAuth: `Bearer ${adminApiSecret()}`,
    echoUrl: echoUrl(),
    header: HEADER,
    secretReference: secretReference(),
  })) as { body: unknown; status: number };
  expect(probe.status).toBe(200);
  expect(echoedHeader(probe.body)).toContain(SECRET_MATERIAL);
});

// ---- helpers ----------------------------------------------------------------

function secretReference() {
  return `Bearer getSecret({ key: ${JSON.stringify(SECRET_KEY)} })`;
}

function echoedHeader(body: unknown): string {
  const headers =
    ((body as { headers?: Record<string, string | string[]> }).headers as Record<
      string,
      string | string[]
    >) ?? {};
  const value = headers[HEADER] ?? headers[HEADER.toUpperCase()] ?? "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}

function connectGlobal(): ItxClient {
  return connectItx({ baseUrl: baseUrl(), token: adminApiSecret() });
}

function adminApiSecret() {
  const secret =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for itx e2e tests.");
  return secret;
}

function baseUrl() {
  const url =
    process.env.OS_ITX_E2E_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    "";
  if (!url) throw new Error("APP_CONFIG_BASE_URL is required for itx e2e tests.");
  return url;
}

/**
 * Worker-to-worker egress cannot loop back to 127.0.0.1 in local dev, so the
 * echo target must be a publicly reachable host (the dev tunnel or a deployed
 * preview). Override with OS_E2E_EGRESS_ECHO_URL when baseUrl is local.
 */
function echoUrl() {
  const explicit = process.env.OS_E2E_EGRESS_ECHO_URL?.trim();
  if (explicit) return explicit;
  const base = new URL(baseUrl());
  if (base.hostname === "localhost" || base.hostname === "127.0.0.1") {
    throw new Error(
      "Set OS_E2E_EGRESS_ECHO_URL to a publicly reachable echo endpoint for local runs " +
        "(e.g. the dev tunnel's /api/itx/egress-echo).",
    );
  }
  return new URL("/api/itx/egress-echo", baseUrl()).toString();
}
