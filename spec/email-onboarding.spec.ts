import { expect } from "@playwright/test";
import { getDbWithEnv } from "../apps/os/backend/db/client.ts";
import { resolveLocalDockerPostgresPort } from "../apps/os/scripts/local-docker-postgres-port.ts";
import { test } from "./test-helpers.ts";
import { createSpecMachine } from "./helpers/spec-machine.ts";

const localDatabaseUrl = `postgres://postgres:postgres@localhost:${resolveLocalDockerPostgresPort()}/os`;

async function withLocalDb<T>(
  fn: (
    db: Awaited<ReturnType<typeof getDbWithEnv>>,
    pgClient: {
      query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
      end(): Promise<void>;
    },
  ) => Promise<T>,
) {
  const db = await getDbWithEnv({ DATABASE_URL: localDatabaseUrl });
  const pgClient = db.$client as {
    query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
  try {
    return await fn(db, pgClient);
  } finally {
    await pgClient.end();
  }
}

function forwardedEmailWebhookPayloads(specMachine: Awaited<ReturnType<typeof createSpecMachine>>) {
  return specMachine.requests
    .filter((request) => request.path === "/api/integrations/email/webhook")
    .map((request) => request.json);
}

test.beforeEach(() =>
  withLocalDb((_db, pgClient) => pgClient.query(`select pgmq.purge_queue('consumer_job_queue')`)),
);

test("unknown allowlisted sender gets onboarded and email webhook is eventually forwarded", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    subject: "tell me a joke",
    text: "not a pun though",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 16_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "tell me a joke",
          }),
          _iterate: expect.objectContaining({
            emailBody: expect.objectContaining({
              text: "not a pun though",
            }),
          }),
        }),
      ]),
    );
});

test("second email sent while the machine is still starting is forwarded after activation", async () => {
  await using specMachine = await createSpecMachine();
  specMachine.requestHandlers.unshift(async (request) => {
    if (new URL(request.url).pathname === "/bootstrap") {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  });

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await specMachine.sendFakeResendWebhook({
    subject: "second email",
    text: "second body",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 2_000 })
    .toEqual([]);

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 22_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "second email",
          }),
        }),
      ]),
    );
});

test("existing user with active machine forwards immediately without onboarding", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 16_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
      ]),
    );

  await specMachine.sendFakeResendWebhook({
    subject: "second email",
    text: "second body",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 8_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "second email",
          }),
        }),
      ]),
    );
});

test("non-allowlisted sender does not onboard and does not forward", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    from: `spec-${Date.now()}@example.com`,
    subject: "tell me a joke",
    text: "not a pun though",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 2_000 })
    .toEqual([]);
});

test("second email from a brand new sender before user creation is also eventually forwarded", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await specMachine.sendFakeResendWebhook({
    subject: "second email",
    text: "second body",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 18_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "second email",
          }),
        }),
      ]),
    );
});

test("active machine webhook failure remains recoverable", async () => {
  await using specMachine = await createSpecMachine();
  let failedOnce = false;
  specMachine.requestHandlers.unshift(function failFirstEmailWebhook(request) {
    if (new URL(request.url).pathname !== "/api/integrations/email/webhook" || failedOnce) {
      return;
    }

    failedOnce = true;
    return new Response("nope", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  });

  await specMachine.sendFakeResendWebhook({
    subject: "retry me",
    text: "please",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 18_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "retry me",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "retry me",
          }),
        }),
      ]),
    );
});
