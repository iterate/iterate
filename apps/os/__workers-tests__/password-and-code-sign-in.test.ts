// The sign-ins without an identity provider (src/password-and-code-sign-in.ts): the password's wrong-try
// caps, and the email code with a fake mailbox, so the test can read the code it mailed: the message,
// the right code, the wrong ones, the spent challenge, the reserved domains.
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { Env } from "../src/env.ts";
import {
  finishLoginCode,
  signInWithPassword,
  startLoginCode,
} from "../src/password-and-code-sign-in.ts";
import { loginPassword, ORIGIN } from "./support.ts";

/** What password-and-code-sign-in.ts hands the mailbox: the builder shape of `SendEmail.send`. */
type Mail = { to: string; from: string; subject: string; text: string; html: string };

test("a client's wrong passwords are capped at twenty, and the right password clears them: one wrong try per sign-in never adds up", async () => {
  const client = `client-${crypto.randomUUID()}`;
  const wrong = (n: number) =>
    signInWithPassword(env, `wrong-${n}-${client}@example.com`, "not-the-password", client);
  // a sign-in that got the password wrong once, then right — thirty times over from one client
  for (let n = 0; n < 30; n++) {
    expect(await wrong(n)).toEqual({ error: "That password is not right." });
    expect(
      await signInWithPassword(env, `right-${n}-${client}@example.com`, loginPassword(), client),
    ).toMatchObject({ user: { email: `right-${n}-${client}@example.com` } });
  }
  // twenty wrong tries in a row still close the client, the right password included
  for (let n = 0; n < 20; n++)
    expect(await wrong(100 + n)).toEqual({ error: "That password is not right." });
  expect(
    await signInWithPassword(env, `late-${client}@example.com`, loginPassword(), client),
  ).toEqual({ error: "Too many tries. Wait a few minutes." });
});

test("the mailed code signs in; a wrong code costs a try; five wrong tries end the challenge; three codes per address per window; a reserved test domain gets no mail", async () => {
  const send = vi.fn<(mail: Mail) => Promise<{ messageId: string }>>(async () => ({
    messageId: "message-1",
  }));
  const mailbox = {
    ...env,
    EMAIL: { send } as unknown as Env["EMAIL"],
    APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@control.test>",
  } as Env;
  const started = await startLoginCode(mailbox, "Person@Real-Mailbox.dev", null);
  expect(send).toHaveBeenCalledTimes(1);
  const message = send.mock.calls[0]![0];
  expect(message).toMatchObject({
    to: "person@real-mailbox.dev",
    from: "iterate <login@control.test>",
  });
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
  const second = await startLoginCode(mailbox, "person@real-mailbox.dev", null);
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
  await startLoginCode(mailbox, "person@real-mailbox.dev", null);
  expect(send).toHaveBeenCalledTimes(3);
  await expect(startLoginCode(mailbox, "Person@Real-Mailbox.dev", null)).rejects.toThrow(
    /Too many/,
  );
  send.mockClear();
  await expect(startLoginCode(mailbox, "nobody@example.com", null)).rejects.toThrow(/receive mail/);
  expect(send).not.toHaveBeenCalled();
  // no cookie at all: nothing to finish
  expect(
    await finishLoginCode(mailbox, new Request(`${ORIGIN}/login`, { method: "POST" }), code),
  ).toMatchObject({ restart: true });
});

function withCookie(setCookie: string) {
  return new Request(`${ORIGIN}/login`, {
    method: "POST",
    headers: { cookie: setCookie.split(";")[0]! },
  });
}
