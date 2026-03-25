import { expect } from "@playwright/test";
import { test } from "./test-helpers.ts";
import { createSpecMachine } from "./helpers/spec-machine.ts";

test("unknown allowlisted sender gets onboarded and email webhook is eventually forwarded", async () => {
  await using specMachine = await createSpecMachine();

  await specMachine.sendFakeResendWebhook({
    subject: "tell me a joke",
    text: "not a pun though",
  });

  await expect
    .poll(() => specMachine.requests, { timeout: 20_000 })
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
      timeout: 20_000,
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
      { timeout: 30_000 },
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

// TODO: existing user with active machine forwards immediately without onboarding
// TODO: non-allowlisted sender does not onboard and does not forward
// TODO: second email from a brand new sender before user creation is also eventually forwarded
// TODO: active machine webhook failure remains recoverable
// TODO: existing user with no active machine yet gets replayed after activation
