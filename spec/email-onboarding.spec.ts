import { expect } from "@playwright/test";
import { createSpecMachine } from "./helpers/spec-machine.ts";
import { test } from "./test-helpers.ts";

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
        expect.objectContaining({ path: "/bootstrap" }),
        expect.objectContaining({
          path: "/api/integrations/email/webhook",
          json: expect.objectContaining({
            data: expect.objectContaining({ subject: "tell me a joke" }),
            _iterate: expect.objectContaining({
              emailBody: expect.objectContaining({ text: "not a pun though" }),
            }),
          }),
        }),
      ]),
    );
});
