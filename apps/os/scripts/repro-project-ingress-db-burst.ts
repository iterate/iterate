import http from "node:http";
import https from "node:https";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import * as schema from "../backend/db/schema.ts";
import { resolveLocalDockerPostgresPort } from "./local-docker-postgres-port.ts";

const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://postgres:postgres@127.0.0.1:${resolveLocalDockerPostgresPort()}/os`;
const workerUrl = process.env.WORKER_URL ?? "http://127.0.0.1:5173";
const projectIngressDomain =
  process.env.PROJECT_INGRESS_DOMAIN ??
  (process.env.ITERATE_USER ? `${process.env.ITERATE_USER}.iterate-dev.app` : "iterate.app");
const controlPlaneHost =
  process.env.CONTROL_PLANE_HOST ??
  (process.env.ITERATE_USER
    ? `${process.env.ITERATE_USER}.iterate-dev.com`
    : process.env.VITE_PUBLIC_URL
      ? new URL(process.env.VITE_PUBLIC_URL).host
      : "localhost:5173");

const requestCount = Number(process.env.REQUEST_COUNT ?? "100");
const warmCache = process.env.WARM_CACHE === "true";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userId = `usr_real_db_${suffix}`;
const organizationId = `org_real_db_${suffix}`;
const membershipId = `member_real_db_${suffix}`;
const projectId = `prj_real_db_${suffix}`;
const machineId = `mach_real_db_${suffix}`;
const slug = `realdb-${suffix}`;
const ingressHost = `${slug}.${projectIngressDomain}`;
const email = `${suffix}@iterate.test`;
const password = `Password-${suffix}`;

const client = postgres(databaseUrl, { prepare: false });
const db = drizzle(client, { schema, casing: "snake_case" });

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function requestWorker(params: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const target = new URL(params.path, workerUrl);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: params.method ?? "GET",
        headers: params.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          });
        });
      },
    );

    request.on("error", reject);
    if (params.body) request.write(params.body);
    request.end();
  });
}

async function makeIngressRequest(cookieHeader: string) {
  return requestWorker({
    path: "/api/health",
    headers: {
      cookie: cookieHeader,
      host: ingressHost,
    },
  });
}

async function seedData() {
  await db.insert(schema.user).values({
    id: userId,
    name: "Real Worker Repro",
    email,
    role: "user",
  });

  await db.insert(schema.account).values({
    accountId: email,
    providerId: "credential",
    userId,
    password: await hashPassword(password),
  });

  await db.insert(schema.organization).values({
    id: organizationId,
    name: `Real Worker Org ${suffix}`,
    slug: `real-worker-org-${suffix}`,
  });

  await db.insert(schema.organizationUserMembership).values({
    id: membershipId,
    organizationId,
    userId,
    role: "member",
  });

  await db.insert(schema.project).values({
    id: projectId,
    name: `Real Worker Project ${suffix}`,
    slug,
    organizationId,
    sandboxProvider: "docker",
  });

  await db.insert(schema.machine).values({
    id: machineId,
    projectId,
    name: `Real Worker Machine ${suffix}`,
    type: "docker",
    state: "active",
    externalId: `ext-${suffix}`,
    metadata: {},
  });
}

function summarizeStatuses(responses: HttpResult[]) {
  const counts = new Map<number, number>();
  for (const response of responses) {
    counts.set(response.status, (counts.get(response.status) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a - b));
}

async function main() {
  console.log(`Target worker: ${workerUrl}`);
  console.log(`Control plane host: ${controlPlaneHost}`);
  console.log(`Seeding repro data for ingress host ${ingressHost}`);

  await seedData();

  try {
    await requestWorker({
      path: "/api/observability",
      headers: { host: controlPlaneHost },
    });
  } catch (error) {
    throw new Error(
      `Could not reach local OS worker at ${workerUrl}. Start it with pnpm dev in apps/os.`,
      { cause: error },
    );
  }

  const signInResponse = await requestWorker({
    path: "/api/auth/sign-in/email",
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: controlPlaneHost,
    },
    body: JSON.stringify({ email, password }),
  });

  if (signInResponse.status < 200 || signInResponse.status >= 300) {
    throw new Error(`Sign-in failed with status ${signInResponse.status}: ${signInResponse.body}`);
  }

  const setCookies = Array.isArray(signInResponse.headers["set-cookie"])
    ? signInResponse.headers["set-cookie"]
    : signInResponse.headers["set-cookie"]
      ? [signInResponse.headers["set-cookie"]]
      : [];

  const cookieHeader = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");

  if (!cookieHeader) {
    throw new Error("Sign-in did not return a session cookie");
  }

  if (warmCache) {
    console.log("Warming ingress cache with one request");
    const warmResponse = await makeIngressRequest(cookieHeader);
    console.log(`Warm request status: ${warmResponse.status}`);
  }

  console.log(`Sending ${requestCount} concurrent requests through the real OS worker`);

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: requestCount }, () => makeIngressRequest(cookieHeader)),
  );

  const responses = results
    .filter((result): result is PromiseFulfilledResult<HttpResult> => result.status === "fulfilled")
    .map((result) => result.value);
  const rejections = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  console.log(`Completed in ${Date.now() - startedAt}ms`);
  console.log(`HTTP status counts: ${JSON.stringify(summarizeStatuses(responses))}`);
  console.log(`Transport rejections: ${rejections.length}`);

  const firstErrorResponse = responses.find(
    (response) => response.status >= 500 && response.status !== 502,
  );
  if (firstErrorResponse) {
    console.log(`First non-proxy 5xx status: ${firstErrorResponse.status}`);
    console.log(firstErrorResponse.body);
  }

  if (rejections.length > 0) {
    console.log("First transport rejection:");
    console.dir(rejections[0].reason, { depth: 5 });
  }
}

try {
  await main();
} finally {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await client.end();
}
