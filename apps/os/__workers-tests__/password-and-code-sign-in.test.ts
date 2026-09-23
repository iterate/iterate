// The email code sign-in (src/password-and-code-sign-in.ts) with a fake mailbox, so the test can read the code it
// mailed: the message, the right code, the wrong ones, the spent challenge, the reserved domains.
import { env } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { finishLoginCode, startLoginCode } from "../src/password-and-code-sign-in.ts";

const origin = "https://control.test";
const withCookie = (setCookie: string) =>
  new Request(`${origin}/login`, {
    method: "POST",
    headers: { cookie: setCookie.split(";")[0]! },
  });

/** What password-and-code-sign-in.ts hands the mailbox: the builder shape of `SendEmail.send`. */
type Mail = { to: string; from: string; subject: string; text: string; html: string };

test("the mailed code signs in; a wrong code costs a try; five wrong tries end the challenge; three codes per address per window; a reserved test domain gets no mail", async () => {
  const send = vi.fn<(mail: Mail) => Promise<{ messageId: string }>>(async () => ({
    messageId: "message-1",
  }));
  const mailbox = {
    ...(env as unknown as Env),
    EMAIL: { send } as unknown as Env["EMAIL"],
    APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@control.test>",
  } as Env;
  const started = await startLoginCode(mailbox, "Person@Real-Mailbox.dev");
  expect(send).toHaveBeenCalledTimes(1);
  const message = send.mock.calls[0]![0];
  expect(message.to).toBe("person@real-mailbox.dev");
  expect(message.from).toBe("iterate <login@control.test>");
  const code = /^(\d{6}) is your iterate sign-in code$/.exec(message.subject)![1]!;
  expect(message.text).toContain(code);
  // a wrong code (there is no test code any more: the password is a sign-in of its own) costs a try
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
  // three codes to one address in the window, then the address rests; a reserved test domain is
  // never mailed — no mailbox exists there (mail there bounces, and a bounce costs the sender's
  // reputation) — so no code is even started: the person is told to enter a real address
  await startLoginCode(mailbox, "person@real-mailbox.dev");
  expect(send).toHaveBeenCalledTimes(3);
  await expect(startLoginCode(mailbox, "Person@Real-Mailbox.dev")).rejects.toThrow(/Too many/);
  send.mockClear();
  await expect(startLoginCode(mailbox, "nobody@example.com")).rejects.toThrow(/receive mail/);
  expect(send).not.toHaveBeenCalled();
  // no cookie at all: nothing to finish
  expect(
    await finishLoginCode(mailbox, new Request(`${origin}/login`, { method: "POST" }), code),
  ).toMatchObject({ restart: true });
});
