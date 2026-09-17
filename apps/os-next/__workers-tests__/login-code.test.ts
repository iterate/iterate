// The email code sign-in (src/login-code.ts) with a fake mailbox, so the test can read the code it
// mailed: the message, the right code, the wrong ones, the spent challenge, the reserved domains.
import { env } from "cloudflare:test";
import { beforeAll, expect, test, vi } from "vitest";
import type { Env } from "../src/control-plane.ts";
import { finishLoginCode, startLoginCode } from "../src/login-code.ts";
import { applyDirectorySchema } from "./support.ts";

const origin = "https://control.test";
beforeAll(applyDirectorySchema);
const withCookie = (setCookie: string) =>
  new Request(`${origin}/login`, {
    method: "POST",
    headers: { cookie: setCookie.split(";")[0]! },
  });

/** What login-code.ts hands the mailbox: the builder shape of `SendEmail.send`. */
type Mail = { to: string; from: string; subject: string; text: string; html: string };

test("the mailed code signs in; the test code does not without test mode; five wrong tries end the challenge; a reserved test domain gets no mail", async () => {
  const send = vi.fn<(mail: Mail) => Promise<{ messageId: string }>>(async () => ({
    messageId: "message-1",
  }));
  const mailbox = {
    ...(env as unknown as Env),
    EMAIL: { send } as unknown as Env["EMAIL"],
    APP_CONFIG_TEST_EMAIL_LOGIN: "false",
    APP_CONFIG_LOGIN_EMAIL_FROM: "iterate <login@control.test>",
  } as Env;
  const started = await startLoginCode(mailbox, "Person@Real-Mailbox.dev");
  expect(send).toHaveBeenCalledTimes(1);
  const message = send.mock.calls[0]![0];
  expect(message.to).toBe("person@real-mailbox.dev");
  expect(message.from).toBe("iterate <login@control.test>");
  const code = /^(\d{6}) is your iterate sign-in code$/.exec(message.subject)![1]!;
  expect(message.text).toContain(code);
  // no test mode here: 424242 is just a wrong code, and costs a try
  expect(await finishLoginCode(mailbox, withCookie(started.setCookie), "424242")).toMatchObject({
    error: expect.stringMatching(/not right/),
  });
  expect(await finishLoginCode(mailbox, withCookie(started.setCookie), code)).toMatchObject({
    user: { email: "person@real-mailbox.dev" },
  });
  // spent: the same code again finds no challenge
  expect(await finishLoginCode(mailbox, withCookie(started.setCookie), code)).toMatchObject({
    error: expect.stringMatching(/expired/),
    restart: true,
  });
  // five wrong tries end a challenge, and the right code is then too late
  const second = await startLoginCode(mailbox, "person@real-mailbox.dev");
  for (let attempt = 1; attempt < 5; attempt++)
    expect(await finishLoginCode(mailbox, withCookie(second.setCookie), "111111")).toMatchObject({
      error: expect.stringMatching(/not right/),
    });
  expect(await finishLoginCode(mailbox, withCookie(second.setCookie), "111111")).toMatchObject({
    error: expect.stringMatching(/Too many/),
    restart: true,
  });
  const secondCode = /^(\d{6}) /.exec(send.mock.calls[1]![0].subject)![1]!;
  expect(await finishLoginCode(mailbox, withCookie(second.setCookie), secondCode)).toMatchObject({
    restart: true,
  });
  // a reserved test domain is never mailed — its challenge still exists, for the test code
  send.mockClear();
  await startLoginCode(mailbox, "nobody@example.com");
  expect(send).not.toHaveBeenCalled();
  // no cookie at all: nothing to finish
  expect(
    await finishLoginCode(mailbox, new Request(`${origin}/login`, { method: "POST" }), code),
  ).toMatchObject({ restart: true });
});
