import { describe, expect, it } from "vitest";
import {
  buildProjectEmailMessage,
  emailAddressForProject,
  emailThreadStreamPath,
  foldEmailSenderDirectory,
  normalizeEmailAddress,
  normalizeMessageId,
  parseEmailRecipient,
} from "./utils.ts";

describe("emailAddressForProject", () => {
  it("is <slug>@<domain>", () => {
    expect(emailAddressForProject({ slug: "acme", domain: "iterate.app" })).toBe(
      "acme@iterate.app",
    );
  });
});

describe("buildProjectEmailMessage", () => {
  const projectAddress = "acme@iterate.app";
  const projectName = "Acme";

  it("defaults from to the project's own address", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello" },
    });
    expect(message).toEqual({
      from: { email: "acme@iterate.app", name: "Acme" },
      to: "user@example.com",
      subject: "Hi",
      text: "Hello",
    });
  });

  it("accepts an explicit from matching the project address case-insensitively", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello", from: "ACME@iterate.app" },
    });
    expect(message.from).toEqual({ email: "ACME@iterate.app", name: "Acme" });
  });

  it("rejects sending as anyone else", () => {
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi", text: "x", from: "other@iterate.app" },
      }),
    ).toThrow(/project's own address/);
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi", text: "x", from: "acme@evil.com" },
      }),
    ).toThrow(/project's own address/);
  });

  it("requires a body", () => {
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi" },
      }),
    ).toThrow(/text and\/or html/);
  });

  it("sets threading headers for replies, normalizing angle brackets", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: {
        to: "user@example.com",
        subject: "Re: Hi",
        text: "Hello again",
        inReplyTo: "msg-2@gmail.com",
        references: ["<msg-1@gmail.com>", "msg-2@gmail.com"],
      },
    });
    expect(message.headers).toEqual({
      "In-Reply-To": "<msg-2@gmail.com>",
      References: "<msg-1@gmail.com> <msg-2@gmail.com>",
    });
  });

  it("omits the headers field entirely when not replying", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello" },
    });
    expect(message).not.toHaveProperty("headers");
  });
});

describe("normalizeEmailAddress", () => {
  it("lowercases but preserves +tags and dots (distinct identities)", () => {
    expect(normalizeEmailAddress(" Joe.Bloggs+Test@GMAIL.com ")).toBe("joe.bloggs+test@gmail.com");
  });
});

describe("normalizeMessageId", () => {
  it("strips angle brackets and lowercases", () => {
    expect(normalizeMessageId("<CADkNbACj@Mail.Gmail.Com>")).toBe("cadknbacj@mail.gmail.com");
    expect(normalizeMessageId("plain-id@host")).toBe("plain-id@host");
  });
});

describe("parseEmailRecipient", () => {
  const domain = "iterate.app";

  it("classifies the bot inbox, project slugs, reserved parts, and foreign domains", () => {
    expect(parseEmailRecipient({ address: "BOT@iterate.app", domain })).toEqual({
      kind: "zero-onboarding",
    });
    expect(parseEmailRecipient({ address: "joebloggs@iterate.app", domain })).toEqual({
      kind: "project",
      slug: "joebloggs",
    });
    expect(parseEmailRecipient({ address: "postmaster@iterate.app", domain })).toEqual({
      kind: "reserved",
      localPart: "postmaster",
    });
    expect(parseEmailRecipient({ address: "bot@other.example", domain })).toMatchObject({
      kind: "unroutable",
      reason: "wrong-domain",
    });
    expect(parseEmailRecipient({ address: "acme+p_agent@iterate.app", domain })).toMatchObject({
      kind: "unroutable",
      reason: "subaddress-not-supported",
    });
  });
});

describe("emailThreadStreamPath", () => {
  it("is deterministic and email-client safe", () => {
    expect(emailThreadStreamPath("<Msg-1@Gmail.Com>")).toBe("/agents/email/thread-msg-1-gmail-com");
    expect(emailThreadStreamPath("msg-1@gmail.com")).toBe(emailThreadStreamPath("MSG-1@GMAIL.COM"));
  });

  it("caps very long message ids with a stable hash", () => {
    const long = `${"a".repeat(100)}@mail.example.com`;
    const path = emailThreadStreamPath(long);
    expect(path.length).toBeLessThan("/agents/email/thread-".length + 41);
    expect(path).toBe(emailThreadStreamPath(long));
    expect(path).not.toBe(emailThreadStreamPath(`${"a".repeat(101)}@mail.example.com`));
  });
});

describe("foldEmailSenderDirectory", () => {
  it("first claim wins per address (deterministic under provisioning races)", () => {
    const events = [
      {
        type: "events.iterate.com/email/sender-claimed",
        payload: { address: "joe@gmail.com", projectId: "prj_first" },
      },
      {
        type: "events.iterate.com/email/sender-claimed",
        payload: { address: "joe@gmail.com", projectId: "prj_second" },
      },
      { type: "events.iterate.com/email/sender-claimed", payload: { address: "no-project-id" } },
      { type: "events.iterate.com/something-else", payload: { address: "x", projectId: "y" } },
    ];
    const folded = foldEmailSenderDirectory(events);
    expect(folded.get("joe@gmail.com")).toBe("prj_first");
    expect(folded.size).toBe(1);
  });
});
