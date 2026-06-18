import type { AppConfig } from "~/config.ts";
import type { CloudflareArtifactsBinding } from "~/domains/repos/artifacts.ts";
import { seedIterateConfigBaseRepo } from "~/domains/repos/iterate-config-base-seed.ts";
import { authenticateAdminBearer } from "~/auth/admin.ts";

const OPENAPI_FIXTURE_BASE = "/api/itx/openapi-fixture";

/**
 * Admin-token-gated debug and operations endpoints that bypass the normal
 * request pipeline (no evlog, no ingress routing). Returns null for anything
 * that is not one of these routes.
 */
export async function handleDebugRoutes(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}): Promise<Response | null> {
  return (
    (await handleOpenApiFixtureFetch(input)) ?? (await handleSeedIterateConfigBaseFetch(input))
  );
}

/**
 * A tiny, deterministic OpenAPI service — the spec document plus the API it
 * describes — so the OpenApiClient e2e never depends on a live third-party
 * demo server. The e2e provides the capability with an admin bearer in
 * props.headers, which also proves that headers ride every API call (nothing
 * here answers without them).
 */
async function handleOpenApiFixtureFetch(input: {
  request: Request;
  config: AppConfig;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (
    url.pathname !== OPENAPI_FIXTURE_BASE &&
    !url.pathname.startsWith(`${OPENAPI_FIXTURE_BASE}/`)
  ) {
    return null;
  }

  const expectedToken = input.config.adminApiSecret?.exposeSecret();
  if (
    expectedToken == null ||
    input.request.headers.get("authorization") !== `Bearer ${expectedToken}`
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const subpath = url.pathname.slice(OPENAPI_FIXTURE_BASE.length);
  if (subpath === "/openapi.json" && input.request.method === "GET") {
    return Response.json(openApiFixtureSpec());
  }
  if (subpath === "/pets" && input.request.method === "GET") {
    const status = url.searchParams.get("status");
    if (!status) return Response.json({ error: "status is required." }, { status: 400 });
    const limit = Number(url.searchParams.get("limit") ?? "2");
    const pets = [
      { id: 1, name: `${status}-pet-1`, tag: status },
      { id: 2, name: `${status}-pet-2`, tag: status },
    ];
    return Response.json(pets.slice(0, limit));
  }
  if (subpath === "/pets" && input.request.method === "POST") {
    const body = (await input.request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body == null || typeof body.name !== "string") {
      return Response.json({ error: "A pet needs a name." }, { status: 400 });
    }
    return Response.json({ ...body, id: 99 });
  }
  const petMatch = subpath.match(/^\/pets\/(\d+)$/);
  if (petMatch && input.request.method === "GET") {
    const id = Number(petMatch[1]);
    return Response.json({ id, name: `pet-${id}` });
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}

function openApiFixtureSpec() {
  const petRef = { $ref: "#/components/schemas/Pet" };
  return {
    components: {
      schemas: {
        Pet: {
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            tag: { type: "string" },
          },
          required: ["id", "name"],
          type: "object",
        },
      },
    },
    info: { title: "Itx OpenAPI Fixture", version: "1.0.0" },
    openapi: "3.0.3",
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [
            {
              in: "query",
              name: "status",
              required: true,
              schema: { enum: ["available", "pending", "sold"], type: "string" },
            },
            { in: "query", name: "limit", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              content: { "application/json": { schema: { items: petRef, type: "array" } } },
              description: "Pets with the given status.",
            },
          },
          summary: "List pets by status.",
        },
        post: {
          operationId: "createPet",
          requestBody: { content: { "application/json": { schema: petRef } } },
          responses: {
            "200": {
              content: { "application/json": { schema: petRef } },
              description: "The created pet.",
            },
          },
          summary: "Create a pet.",
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          parameters: [{ in: "path", name: "petId", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              content: { "application/json": { schema: petRef } },
              description: "The pet.",
            },
          },
          summary: "One pet by id.",
        },
      },
    },
    servers: [{ url: OPENAPI_FIXTURE_BASE }],
  };
}

async function handleSeedIterateConfigBaseFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}) {
  const { request, env, config } = input;
  const url = new URL(request.url);
  if (url.pathname !== "/__debug/seed-iterate-config-base") return null;

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const expectedToken = config.adminApiSecret?.exposeSecret();
  if (expectedToken == null) {
    return Response.json({ error: "Seed endpoint is disabled." }, { status: 404 });
  }

  if (
    !authenticateAdminBearer({
      authorizationHeader: request.headers.get("authorization"),
      config,
    })
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const envWithArtifacts = env as Env & { ARTIFACTS?: CloudflareArtifactsBinding };
  if (!envWithArtifacts.ARTIFACTS) {
    return Response.json({ error: "ARTIFACTS binding is not configured." }, { status: 500 });
  }
  if (!env.ARTIFACTS_ACCOUNT_ID || !env.ARTIFACTS_NAMESPACE) {
    return Response.json(
      { error: "Artifacts account and namespace bindings are not configured." },
      { status: 500 },
    );
  }

  try {
    return Response.json(
      await seedIterateConfigBaseRepo({
        accountId: env.ARTIFACTS_ACCOUNT_ID,
        artifacts: envWithArtifacts.ARTIFACTS,
        namespace: env.ARTIFACTS_NAMESPACE,
      }),
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
        },
      },
      { status: 500 },
    );
  }
}

/**
 * Proxy `/__durable-objects/<kind>/<name>/<path>` to a durable object's fetch
 * handler for debugging. Runs inside the normal pipeline (after ingress
 * routing), unlike the routes above.
 *
 * Admin-token gated: this proxies arbitrary requests straight into a DO's
 * fetch handler, so it must never be reachable anonymously. (Today only
 * PROJECT exposes a fetch handler and it self-authenticates, but the gate
 * keeps that from being load-bearing as new DO fetch handlers are added.)
 */
export async function handleDurableObjectDebugFetch(input: {
  request: Request;
  env: Env;
  config: AppConfig;
}) {
  const url = new URL(input.request.url);
  const match = url.pathname.match(/^\/__durable-objects\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  if (input.config.adminApiSecret == null) {
    return Response.json({ error: "Durable Object debug proxy is disabled." }, { status: 404 });
  }
  if (
    !authenticateAdminBearer({
      authorizationHeader: input.request.headers.get("authorization"),
      config: input.config,
    })
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const objectKind = match[1];
  const objectName = decodeURIComponent(match[2] ?? "");
  const targetPath = match[3] ?? "/";
  const namespace = readDebugDurableObjectNamespace(input.env, objectKind);
  if (!namespace) {
    return new Response(`Unknown Durable Object debug namespace: ${objectKind}`, { status: 404 });
  }

  const targetUrl = new URL(input.request.url);
  targetUrl.pathname = targetPath;
  const stub = namespace.getByName(objectName);
  return await stub.fetch(new Request(targetUrl, input.request));
}

type DebugDurableObjectNamespace = {
  getByName(name: string): {
    fetch(request: Request): Promise<Response>;
  };
};

function readDebugDurableObjectNamespace(
  env: Env,
  objectKind: string,
): DebugDurableObjectNamespace | null {
  switch (objectKind) {
    case "project":
      return env.PROJECT as unknown as DebugDurableObjectNamespace;
    case "stream":
      return env.STREAM as unknown as DebugDurableObjectNamespace;
    default:
      return null;
  }
}
