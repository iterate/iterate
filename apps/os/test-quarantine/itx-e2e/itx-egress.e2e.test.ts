// QUARANTINED (itx-v4 cutover) — origin: apps/os/src/itx/e2e/itx-egress.e2e.test.ts
// Covered: legacy itx egress — the explicit itx.fetch(...) door and the implicit
// bare-fetch door inside platform-loaded isolates, with getSecret(...) placeholder
// substitution proven against a public echo endpoint, plus the itx.secrets
// setSecret → placeholder-fetch lifecycle.
// Why quarantined: legacy itx surface removed in the itx-v4 cutover; superseded by
// apps/os/e2e/engine/* engine suites (project egress + secret substitution are
// covered by the "Project egress substitutes path-addressed secrets" tests).

// Egress: one pipe, two doors (Law 5), proven against a real deployment.
//
//   explicit door  itx.fetch(...) — available to every handle holder,
//                  including this Node process (tier 3: hardware we don't load)
//   implicit door  bare fetch() inside isolates the platform loads —
//                  /api/itx/run scripts and worker caps get ProjectEgress as
//                  their globalOutbound, so even a dependency's fetch goes
//                  through secret substitution without knowing it
//
// The tests store an example secret (example.egress_api_key →
// "example-secret-value"), send getSecret(...) placeholders to a public echo
// endpoint, and assert the remote side saw the substituted material.

import { expect, test as baseTest } from "vitest";
import {
  adminApiSecret,
  baseUrl,
  connectGlobal,
  registerCreatedProjectCleanup,
} from "./e2e-env.ts";

const SECRET_KEY = "example.egress_api_key";
const SECRET_MATERIAL = "example-secret-value";
const HEADER = "x-itx-egress-probe";
const PUBLIC_ECHO_URL = "https://postman-echo.com/get";

const createdProjectIds = registerCreatedProjectCleanup();
const test = process.env.OS_ITX_E2E_EGRESS_CONCURRENT === "true" ? baseTest.concurrent : baseTest;

test("itx.fetch substitutes secrets through project egress (explicit door)", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-egress-${suffix()}` })) as { id: string };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);
  await waitForProjectReady(projectItx);
  await seedExampleSecret(projectItx);

  const response = await projectFetchWithTransientRetry(projectItx, echoUrl(), {
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
  createdProjectIds.push(project.id);
  {
    using projectItx = await itx.projects.get(project.id);
    await waitForProjectReady(projectItx);
    await seedExampleSecret(projectItx);
  }

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
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);
  await waitForProjectReady(projectItx);
  await seedExampleSecret(projectItx);

  await projectItx.provideCapability({
    name: "egressProbe",
    capability: {
      type: "rpc",
      worker: {
        type: "source",
        source: {
          type: "inline",
          cacheKey: crypto.randomUUID(),
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

test("itx.secrets: set a secret through the default, then fetch with its placeholder", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: `itx-secrets-${suffix()}` })) as {
    id: string;
  };
  createdProjectIds.push(project.id);
  using projectItx = await itx.projects.get(project.id);
  await waitForProjectReady(projectItx);

  // The secrets-and-egress catalogue example's flow: store material once via
  // the `secrets` default, reference it by KEY in an egress header,
  // and the pipe substitutes server-side.
  const handle = projectItx as never as Record<string, any>;
  const material = `lifecycle-${crypto.randomUUID()}`;
  await handle.secrets.setSecret({ key: "demo.api_key", material });

  const listed = (await handle.secrets.listSecrets()) as Array<{ key: string }>;
  expect(listed.map((secret) => secret.key)).toContain("demo.api_key");
  // Summaries are redacted — material never rides the list surface.
  expect(JSON.stringify(listed)).not.toContain(material);

  const response = await projectFetchWithTransientRetry(projectItx, echoUrl(), {
    headers: {
      authorization: `Bearer ${adminApiSecret()}`,
      [HEADER]: 'getSecret({ key: "demo.api_key" })',
    },
  });
  expect(response.status).toBe(200);
  expect(echoedHeader(await response.json())).toContain(material);

  await handle.secrets.deleteSecret({ key: "demo.api_key" });
  const afterDelete = (await handle.secrets.listSecrets()) as Array<{ key: string }>;
  expect(afterDelete.map((secret) => secret.key)).not.toContain("demo.api_key");
});

// ---- helpers ----------------------------------------------------------------

/**
 * createProject returns immediately; the creation steps (including the
 * example secret these tests rely on) run in ProjectProcessor and leave a
 * trail of events. Poll the processor snapshot until phase "ready" — in ONE
 * expression: itx.project is a path proxy over the Project DO, so deep
 * property traversal pipelines (`itx.project.processor.snapshot()`).
 */
async function waitForProjectReady(projectItx: unknown) {
  const project = (
    projectItx as {
      project: { processor: { snapshot(): Promise<{ state: { phase: string } }> } };
    }
  ).project;
  const deadline = Date.now() + 90_000;
  let snapshot: { state: { phase: string } } | undefined;
  while (Date.now() < deadline) {
    snapshot = await project.processor.snapshot();
    if (snapshot.state.phase === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for create-completed: ${JSON.stringify(snapshot)}`);
}

function secretReference() {
  return `Bearer getSecret({ key: ${JSON.stringify(SECRET_KEY)} })`;
}

async function seedExampleSecret(projectItx: unknown) {
  await (projectItx as never as Record<string, any>).secrets.setSecret({
    key: SECRET_KEY,
    material: SECRET_MATERIAL,
  });
}

async function projectFetchWithTransientRetry(
  projectItx: { fetch(input: string, init: RequestInit): Promise<Response> },
  input: string,
  init: RequestInit,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await projectItx.fetch(input, init);
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error && /network connection lost/i.test(error.message)) ||
        attempt === 3
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
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

function echoUrl() {
  const explicit = process.env.OS_E2E_EGRESS_ECHO_URL?.trim();
  if (explicit) return explicit;
  return PUBLIC_ECHO_URL;
}
