import { expect } from "@playwright/test";
import { getDbWithEnv } from "../apps/os/backend/db/client.ts";
import { outboxClient } from "../apps/os/backend/outbox/client.ts";
import { queuer } from "../apps/os/backend/outbox/outbox-queuer.ts";
import { resolveLocalDockerPostgresPort } from "../apps/os/scripts/local-docker-postgres-port.ts";
import { test } from "./test-helpers.ts";
import { createSpecMachine, sendFakeResendWebhookPayload } from "./helpers/spec-machine.ts";

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
    .poll(() => specMachine.requests, { timeout: 40_000 })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/api/integrations/email/webhook",
          json: expect.objectContaining({
            data: expect.objectContaining({
              subject: "tell me a joke",
            }),
            _iterate: expect.objectContaining({
              emailBody: expect.objectContaining({
                text: "not a pun though",
              }),
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

  await expect
    .poll(() => specMachine.requests.filter((request) => request.path === "/bootstrap").length, {
      timeout: 40_000,
    })
    .toBe(1);

  await specMachine.sendFakeResendWebhook({
    subject: "second email",
    text: "second body",
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ),
      { timeout: 40_000 },
    )
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

test("existing user with active machine forwards immediately without onboarding", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ).length,
      { timeout: 40_000 },
    )
    .toBe(1);

  const bootstrapCountBeforeSecondEmail = specMachine.requests.filter(
    (request) => request.path === "/bootstrap",
  ).length;

  await specMachine.sendFakeResendWebhook({
    subject: "second email",
    text: "second body",
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ).length,
      { timeout: 20_000 },
    )
    .toBe(2);

  expect(
    specMachine.requests.filter((request) => request.path === "/bootstrap").length,
  ).toBe(bootstrapCountBeforeSecondEmail);
});

test("non-allowlisted sender does not onboard and does not forward", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    from: `spec-${Date.now()}@example.com`,
    subject: "tell me a joke",
    text: "not a pun though",
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) =>
            request.path === "/bootstrap" || request.path === "/api/integrations/email/webhook",
        ).length,
      { timeout: 10_000 },
    )
    .toBe(0);
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
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ),
      { timeout: 40_000 },
    )
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
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ).length,
      { timeout: 90_000 },
    )
    .toBe(2);
});

test("existing user with no active machine yet gets replayed after activation", async () => {
  await using specMachine = await createSpecMachine();
  outboxClient.registerConsumer({
    name: "testReplayPendingEmailDeliveries",
    on: "machine:activated",
    async handler(params) {
      await withLocalDb(async (_db, pgClient) => {
        const { rows } = await pgClient.query<{ payload: Record<string, unknown> }>(
          `
            select outbox_event.payload as payload
            from email_inbound_delivery
            join outbox_event
              on outbox_event.id = email_inbound_delivery.outbox_event_id
            where email_inbound_delivery.project_id = $1
              and email_inbound_delivery.status = 'pending'
            order by email_inbound_delivery.created_at desc
            limit 1
          `,
          [params.payload.projectId],
        );

        for (const { payload } of rows) {
          await sendFakeResendWebhookPayload(payload);
        }
      });

      return `replayed pending emails for ${params.payload.projectId}`;
    },
  });

  await specMachine.sendFakeResendWebhook({
    subject: "first email",
    text: "first body",
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ).length,
      { timeout: 40_000 },
    )
    .toBe(1);

  await withLocalDb(async (db, pgClient) => {
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

    await pgClient.query(`update machine set state = $1 where id = $2`, ["detached", routing.machineId]);

    await specMachine.sendFakeResendWebhook({
      subject: "second email",
      text: "second body",
    });

    await expect
      .poll(
        () =>
          specMachine.requests.filter(
            (request) => request.path === "/api/integrations/email/webhook",
          ).length,
        { timeout: 10_000 },
      )
      .toBe(1);

    await pgClient.query(`update machine set state = $1 where id = $2`, ["active", routing.machineId]);

    await outboxClient.send(db, {
      name: "machine:activated",
      payload: {
        machineId: routing.machineId,
        projectId: routing.projectId,
        detachedMachineIds: [],
      },
    });
    await queuer.processQueue(db);
  });

  await expect
    .poll(
      () =>
        specMachine.requests.filter(
          (request) => request.path === "/api/integrations/email/webhook",
        ),
      { timeout: 40_000 },
    )
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
