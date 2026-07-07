import { describe, expect, it } from "vitest";
import {
  assertEmailMessageWithinLimits,
  buildProjectEmailMessage,
  decodeBase64Attachment,
  dmarcPasses,
  emailAddressForProject,
  emailAgentPath,
  emailThreadIdFromAgentPath,
  emailThreadReplyAddress,
  isEmailAgentPath,
  normalizeMessageId,
  parseInboundRecipient,
  parseMessageIdList,
  replySubject,
  senderMatchesAllowlist,
  EMAIL_MAX_MESSAGE_BYTES,
  type OutboundEmailAttachment,
} from "./utils.ts";

describe("emailAddressForProject", () => {
  it("is <slug>@<domain>", () => {
    expect(emailAddressForProject({ slug: "acme", domain: "iterate.app" })).toBe(
      "acme@iterate.app",
    );
  });
});

describe("email thread addressing", () => {
  it("round-trips threadId through reply address, agent path, and back", () => {
    expect(emailThreadReplyAddress({ slug: "acme", domain: "iterate.app", threadId: "42" })).toBe(
      "acme+t42@iterate.app",
    );
    expect(emailAgentPath("42")).toBe("/agents/email/t42");
    expect(emailThreadIdFromAgentPath("/agents/email/t42")).toBe("42");
  });

  it("emailThreadIdFromAgentPath rejects non-thread paths", () => {
    expect(emailThreadIdFromAgentPath("/agents/email")).toBeNull();
    expect(emailThreadIdFromAgentPath("/agents/slack/c123/ts-1")).toBeNull();
    expect(emailThreadIdFromAgentPath("/agents/email/t42/child")).toBeNull();
  });

  it("isEmailAgentPath matches /agents/email and below", () => {
    expect(isEmailAgentPath("/agents/email/t42")).toBe(true);
    expect(isEmailAgentPath("/agents/email")).toBe(true);
    expect(isEmailAgentPath("/agents/emailish")).toBe(false);
  });
});

describe("parseInboundRecipient", () => {
  it("parses the project inbox address", () => {
    expect(parseInboundRecipient("acme@iterate.app")).toEqual({
      domain: "iterate.app",
      slug: "acme",
      threadId: null,
    });
  });

  it("parses a thread reply tag, case-folded and angle-bracket tolerant", () => {
    expect(parseInboundRecipient("<Acme+T42@Iterate.App>")).toEqual({
      domain: "iterate.app",
      slug: "acme",
      threadId: "42",
    });
  });

  it("keeps the slug but drops an unrecognized tag", () => {
    expect(parseInboundRecipient("acme+newsletter@iterate.app")).toEqual({
      domain: "iterate.app",
      slug: "acme",
      threadId: null,
    });
  });

  it("rejects malformed addresses", () => {
    expect(parseInboundRecipient("no-at-sign")).toBeNull();
    expect(parseInboundRecipient("@iterate.app")).toBeNull();
    expect(parseInboundRecipient("acme@")).toBeNull();
    expect(parseInboundRecipient("+t42@iterate.app")).toBeNull();
  });
});

describe("senderMatchesAllowlist", () => {
  it("matches exact addresses case-insensitively", () => {
    expect(
      senderMatchesAllowlist({ address: "Jonas@Example.com", patterns: ["jonas@example.com"] }),
    ).toBe(true);
  });

  it("matches whole domains with *@", () => {
    expect(
      senderMatchesAllowlist({ address: "anyone@example.com", patterns: ["*@example.com"] }),
    ).toBe(true);
    expect(
      senderMatchesAllowlist({ address: "anyone@evil.com", patterns: ["*@example.com"] }),
    ).toBe(false);
    // Subdomains are NOT covered by a domain pattern.
    expect(
      senderMatchesAllowlist({ address: "anyone@sub.example.com", patterns: ["*@example.com"] }),
    ).toBe(false);
  });

  it("matches nothing on an empty pattern list (closed by default)", () => {
    expect(senderMatchesAllowlist({ address: "jonas@example.com", patterns: [] })).toBe(false);
  });
});

describe("dmarcPasses", () => {
  it("requires dmarc=pass in the Authentication-Results value", () => {
    expect(dmarcPasses("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass action=none")).toBe(
      true,
    );
    expect(dmarcPasses("mx.cloudflare.net; spf=pass; dmarc=fail")).toBe(false);
    expect(dmarcPasses(null)).toBe(false);
  });
});

describe("message-id helpers", () => {
  it("normalizeMessageId strips angle brackets and whitespace", () => {
    expect(normalizeMessageId(" <abc@mail.example> ")).toBe("abc@mail.example");
    expect(normalizeMessageId("abc@mail.example")).toBe("abc@mail.example");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  it("parseMessageIdList pulls every id out of a References value", () => {
    expect(parseMessageIdList("<a@x> <b@y>\n\t<c@z>")).toEqual(["a@x", "b@y", "c@z"]);
    expect(parseMessageIdList(undefined)).toEqual([]);
  });
});

describe("email attachments", () => {
  const attachment = (bytes: number): OutboundEmailAttachment => ({
    content: new Uint8Array(bytes),
    filename: "file.bin",
    type: "application/octet-stream",
    disposition: "attachment",
  });

  it("threads attachments into the built message", () => {
    const message = buildProjectEmailMessage({
      projectAddress: "acme@iterate.app",
      projectName: "Acme",
      request: {
        to: "user@example.com",
        subject: "Report",
        text: "Attached.",
        attachments: [
          {
            content: new Uint8Array([1, 2, 3]),
            filename: "report.pdf",
            type: "application/pdf",
            disposition: "attachment",
          },
        ],
      },
    });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments![0]).toMatchObject({
      filename: "report.pdf",
      type: "application/pdf",
    });
  });

  it("enforces the 32-file cap", () => {
    expect(() =>
      assertEmailMessageWithinLimits({
        attachments: Array.from({ length: 33 }, () => attachment(1)),
        bodyBytes: 0,
      }),
    ).toThrow(/32 files/);
    expect(() =>
      assertEmailMessageWithinLimits({
        attachments: Array.from({ length: 32 }, () => attachment(1)),
        bodyBytes: 0,
      }),
    ).not.toThrow();
  });

  it("enforces the total message cap at wire (base64) size, bodies included", () => {
    expect(() =>
      assertEmailMessageWithinLimits({
        attachments: [attachment(EMAIL_MAX_MESSAGE_BYTES)],
        bodyBytes: 0,
      }),
    ).toThrow(/5 MiB/);
    // Base64 string content counts at its encoded length verbatim.
    const oversizedBase64: OutboundEmailAttachment = {
      ...attachment(0),
      content: "A".repeat(EMAIL_MAX_MESSAGE_BYTES + 1),
    };
    expect(() =>
      assertEmailMessageWithinLimits({ attachments: [oversizedBase64], bodyBytes: 0 }),
    ).toThrow(/5 MiB/);
    // Bodies count toward the same cap: an attachment that fits alone fails
    // once the body pushes the total over.
    const nearCap = attachment(Math.floor((EMAIL_MAX_MESSAGE_BYTES * 3) / 4) - 1024);
    expect(() =>
      assertEmailMessageWithinLimits({ attachments: [nearCap], bodyBytes: 0 }),
    ).not.toThrow();
    expect(() =>
      assertEmailMessageWithinLimits({ attachments: [nearCap], bodyBytes: 100_000 }),
    ).toThrow(/5 MiB/);
  });

  it("decodeBase64Attachment round-trips bytes and tolerates whitespace", () => {
    expect(Array.from(decodeBase64Attachment(btoa("hello")))).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
    expect(Array.from(decodeBase64Attachment("aGVs\nbG8="))).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
  });
});

describe("replySubject", () => {
  it("prefixes Re: exactly once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject(undefined)).toBe("Re:");
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

  it("sets threading headers with angle brackets", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: {
        to: "user@example.com",
        subject: "Re: Hi",
        text: "Hello again",
        inReplyTo: "abc@mail.example",
        references: ["root@mail.example", "abc@mail.example"],
      },
    });
    expect(message.headers).toEqual({
      "In-Reply-To": "<abc@mail.example>",
      References: "<root@mail.example> <abc@mail.example>",
    });
  });

  it("allows Reply-To only on the project's own address or +tagged variants", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: {
        to: "user@example.com",
        subject: "Hi",
        text: "x",
        replyTo: "acme+t42@iterate.app",
      },
    });
    expect(message.replyTo).toBe("acme+t42@iterate.app");
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "u@e.com", subject: "Hi", text: "x", replyTo: "other@iterate.app" },
      }),
    ).toThrow(/replyTo/);
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "u@e.com", subject: "Hi", text: "x", replyTo: "acme+t42@evil.com" },
      }),
    ).toThrow(/replyTo/);
  });
});
