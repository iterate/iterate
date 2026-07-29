import { describe, expect, test } from "vitest";
import {
  assertEmailMessageWithinLimits,
  buildProjectEmailMessage,
  decodeBase64Attachment,
  dmarcPasses,
  emailAddressForProject,
  emailDomainForDeployment,
  fallbackInboundMessageKey,
  emailAgentPath,
  emailThreadReplyAddress,
  isEmailAgentPath,
  normalizeInboundEmailAllowedSender,
  normalizeMessageId,
  parseInboundRecipient,
  parseMessageIdList,
  replySubject,
  senderMatchesAllowlist,
  EMAIL_MAX_MESSAGE_BYTES,
  type OutboundEmailAttachment,
} from "./utils.ts";

describe("emailDomainForDeployment", () => {
  test("normalizes the first hostname base the way host routing does", () => {
    expect(emailDomainForDeployment(["*.iterate-Preview-3.App", "iterate.app"])).toBe(
      "iterate-preview-3.app",
    );
    expect(emailDomainForDeployment(["iterate.app"])).toBe("iterate.app");
    expect(emailDomainForDeployment([])).toBeNull();
  });
});

describe("emailAddressForProject", () => {
  test("is <slug>@<domain>", () => {
    expect(emailAddressForProject({ slug: "acme", domain: "iterate.app" })).toBe(
      "acme@iterate.app",
    );
  });
});

describe("email thread addressing", () => {
  test("builds the reply address and conventional agent address", () => {
    expect(emailThreadReplyAddress({ slug: "acme", domain: "iterate.app", threadId: "42" })).toBe(
      "acme+t42@iterate.app",
    );
    expect(emailAgentPath("42")).toBe("/agents/email/t42");
  });

  test("isEmailAgentPath matches /agents/email and below", () => {
    expect(isEmailAgentPath("/agents/email/t42")).toBe(true);
    expect(isEmailAgentPath("/agents/email")).toBe(true);
    expect(isEmailAgentPath("/agents/emailish")).toBe(false);
  });
});

describe("parseInboundRecipient", () => {
  test.for([
    {
      name: "parses the project inbox address",
      address: "acme@iterate.app",
      expected: { domain: "iterate.app", slug: "acme", threadId: null } as {
        domain: string;
        slug: string;
        threadId: string | null;
      } | null,
    },
    {
      name: "parses a thread reply tag, case-folded and angle-bracket tolerant",
      address: "<Acme+T42@Iterate.App>",
      expected: { domain: "iterate.app", slug: "acme", threadId: "42" },
    },
    {
      name: "keeps the slug but drops an unrecognized tag",
      address: "acme+newsletter@iterate.app",
      expected: { domain: "iterate.app", slug: "acme", threadId: null },
    },
    { name: "rejects an address without an @", address: "no-at-sign", expected: null },
    { name: "rejects an empty local part", address: "@iterate.app", expected: null },
    { name: "rejects an empty domain", address: "acme@", expected: null },
    { name: "rejects a bare thread tag with no slug", address: "+t42@iterate.app", expected: null },
  ])("$name", ({ address, expected }) => {
    expect(parseInboundRecipient(address)).toEqual(expected);
  });
});

describe("senderMatchesAllowlist", () => {
  test.for([
    {
      name: "matches exact addresses case-insensitively",
      address: "Jonas@Example.com",
      patterns: ["jonas@example.com"],
      expected: true,
    },
    {
      name: "matches whole domains with *@",
      address: "anyone@example.com",
      patterns: ["*@example.com"],
      expected: true,
    },
    {
      name: "does not match other domains against a domain pattern",
      address: "anyone@evil.com",
      patterns: ["*@example.com"],
      expected: false,
    },
    {
      // Subdomains are NOT covered by a domain pattern.
      name: "does not match subdomains against a domain pattern",
      address: "anyone@sub.example.com",
      patterns: ["*@example.com"],
      expected: false,
    },
    {
      name: "matches nothing on an empty pattern list (closed by default)",
      address: "jonas@example.com",
      patterns: [],
      expected: false,
    },
  ])("$name", ({ address, patterns, expected }) => {
    expect(senderMatchesAllowlist({ address, patterns })).toBe(expected);
  });
});

describe("normalizeInboundEmailAllowedSender", () => {
  test("canonicalizes exact addresses and whole-domain rules", () => {
    expect(normalizeInboundEmailAllowedSender(" Jonas@Example.COM ")).toBe("jonas@example.com");
    expect(normalizeInboundEmailAllowedSender("*@Iterate.COM")).toBe("*@iterate.com");
  });

  test.for(["jonas", "@example.com", "jo*@example.com", "*@localhost", "jonas@"])(
    "rejects unsupported pattern %s",
    (pattern) => {
      expect(() => normalizeInboundEmailAllowedSender(pattern)).toThrow(
        /exact address or \*@domain/,
      );
    },
  );
});

describe("dmarcPasses", () => {
  test("requires Cloudflare authserv-id with dmarc=pass on the same record", () => {
    expect(dmarcPasses("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass action=none")).toBe(
      true,
    );
    expect(dmarcPasses("mx.cloudflare.net; spf=pass; dmarc=fail")).toBe(false);
    expect(dmarcPasses(null)).toBe(false);
  });

  test("rejects a self-forged Authentication-Results without Cloudflare authserv-id", () => {
    expect(dmarcPasses("evil.example; dmarc=pass")).toBe(false);
    expect(dmarcPasses("fake.local; spf=pass; dmarc=pass")).toBe(false);
    // Prefix forgeries must not satisfy a word-boundary-style pin.
    expect(dmarcPasses("mx.cloudflare.net.evil; dmarc=pass")).toBe(false);
    expect(dmarcPasses("mx.cloudflare.net-evil; dmarc=pass")).toBe(false);
    expect(dmarcPasses("mx.cloudflare.netevil; dmarc=pass")).toBe(false);
  });

  test("allows optional authserv-id version before the semicolon", () => {
    expect(dmarcPasses("mx.cloudflare.net 1; dmarc=pass")).toBe(true);
  });

  test("handles newline-separated AR records (raw MIME)", () => {
    expect(dmarcPasses("evil.example; dmarc=pass\nmx.cloudflare.net; spf=pass; dmarc=pass")).toBe(
      true,
    );
    expect(dmarcPasses("evil.example; dmarc=pass\nmx.cloudflare.net; dmarc=fail")).toBe(false);
  });

  test("handles comma-joined AR records from Headers.get", () => {
    // headers.get("authentication-results") joins duplicates with ", ".
    expect(dmarcPasses("evil.example; dmarc=pass, mx.cloudflare.net; spf=pass; dmarc=pass")).toBe(
      true,
    );
    // A forged pass after a real Cloudflare fail must not match across the join.
    expect(dmarcPasses("mx.cloudflare.net; dmarc=fail, evil.example; dmarc=pass")).toBe(false);
    // Forged alone, still joined shape.
    expect(dmarcPasses("evil.example; dmarc=pass, other.example; spf=pass")).toBe(false);
  });
});

describe("fallbackInboundMessageKey", () => {
  const message = {
    envelopeFrom: "Jonas@Example.com",
    date: "Tue, 07 Jul 2026 12:00:00 +0000",
    subject: "Hello",
    body: "Same body",
  };

  test("is deterministic across retries of the same message", async () => {
    const first = await fallbackInboundMessageKey(message);
    const second = await fallbackInboundMessageKey({
      ...message,
      envelopeFrom: "jonas@example.com",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256-[0-9a-f]{32}$/);
  });

  test("differs for different messages", async () => {
    const first = await fallbackInboundMessageKey(message);
    const second = await fallbackInboundMessageKey({ ...message, body: "Different body" });
    expect(first).not.toBe(second);
  });
});

describe("message-id helpers", () => {
  test("normalizeMessageId strips angle brackets and whitespace", () => {
    expect(normalizeMessageId(" <abc@mail.example> ")).toBe("abc@mail.example");
    expect(normalizeMessageId("abc@mail.example")).toBe("abc@mail.example");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  test("parseMessageIdList pulls every id out of a References value", () => {
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

  test("threads attachments into the built message", () => {
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

  test("enforces the 32-file cap", () => {
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

  test("enforces the total message cap at wire (base64) size, bodies included", () => {
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

  test("decodeBase64Attachment round-trips bytes and tolerates whitespace", () => {
    expect(Array.from(decodeBase64Attachment(btoa("hello")))).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
    expect(Array.from(decodeBase64Attachment("aGVs\nbG8="))).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
  });
});

describe("replySubject", () => {
  test("prefixes Re: exactly once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(replySubject(undefined)).toBe("Re:");
  });
});

describe("buildProjectEmailMessage", () => {
  const projectAddress = "acme@iterate.app";
  const projectName = "Acme";

  test("defaults from to the project's own address", () => {
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

  test("accepts an explicit from matching the project address case-insensitively", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello", from: "ACME@iterate.app" },
    });
    expect(message.from).toEqual({ email: "ACME@iterate.app", name: "Acme" });
  });

  test("rejects sending as anyone else", () => {
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

  test("requires a body", () => {
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi" },
      }),
    ).toThrow(/text and\/or html/);
  });

  test("sets threading headers with angle brackets", () => {
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

  test("allows Reply-To only on the project's own address or +tagged variants", () => {
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
