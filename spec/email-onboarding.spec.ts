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
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 12_000 })
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
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 12_000 })
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
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 12_000 })
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

test("existing user with no active machine yet gets replayed after activation", async () => {
  await using specMachine = await createSpecMachine();
  let shouldHideSetupSentinel = false;
  specMachine.requestHandlers.unshift(async function hideSetupSentinelOnce(request) {
    if (
      !shouldHideSetupSentinel ||
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/api/orpc/tool/readFile"
    ) {
      return;
    }

    const body = (await request.json()) as { json: { path: string } };
    if (body.json.path !== "~/.iterate/.setup-done") {
      return;
    }

    shouldHideSetupSentinel = false;
    return Response.json({
      json: {
        path: body.json.path,
        content: null,
        exists: false,
      },
    });
  });

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 12_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
      ]),
    );

  await withLocalDb(async (_db, pgClient) => {
    const { rows } = await pgClient.query<{ projectId: string; machineId: string }>(
      `
        select
          project.id as "projectId",
          machine.id as "machineId"
        from "user"
        join organization_user_membership
          on organization_user_membership.user_id = "user".id
        join organization
          on organization.id = organization_user_membership.organization_id
        join project
          on project.organization_id = organization.id
        join machine
          on machine.project_id = project.id
        where "user".email = $1
        limit 1
      `,
      [specMachine.senderEmail],
    );
    const [routing] = rows;

    if (!routing) {
      throw new Error(`missing routing for ${specMachine.senderEmail}`);
    }

    await pgClient.query(`update machine set state = $1 where id = $2`, [
      "starting",
      routing.machineId,
    ]);

    await specMachine.sendFakeResendWebhook({
      subject: "second email",
      text: "second body",
    });

    await expect
      .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 2_000 })
      .toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            subject: "first email",
          }),
        }),
      ]);

    await expect
      .poll(
        async () => {
          const pendingRows = await pgClient.query<{ count: string }>(
            `
              select count(*)::text as count
              from email_inbound_delivery
              join outbox_event
                on outbox_event.id = email_inbound_delivery.outbox_event_id
              where email_inbound_delivery.project_id = $1
                and email_inbound_delivery.status = 'pending'
                and outbox_event.payload->'data'->>'subject' = 'second email'
            `,
            [routing.projectId],
          );
          return Number(pendingRows.rows[0]?.count ?? "0");
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    shouldHideSetupSentinel = true;
    await specMachine.reportReady();
  });

  await expect
    .poll(() => forwardedEmailWebhookPayloads(specMachine), { timeout: 12_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          json: expect.objectContaining({
            data: expect.objectContaining({
              subject: "first email",
            }),
          }),
        }),
        expect.objectContaining({
          json: expect.objectContaining({
            data: expect.objectContaining({
              subject: "second email",
            }),
          }),
        }),
      ]),
    );
});
