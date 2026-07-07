import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../config.ts";
import {
  domainsAlignRelaxed,
  handleInboundEmail,
  MAX_INBOUND_EMAIL_BYTES,
  verifySenderAlignment,
  type InboundEmailDeps,
} from "./inbound.ts";

it("verifies, provisions, and appends a routed email/received event", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "joebloggs@gmail.com",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({
        from: "Joe Bloggs <JoeBloggs@gmail.com>",
        subject: "slime volleyball",
        body: "Make me a browser slime volleyball game",
      }),
    },
    deps.deps,
  );

  expect(result).toMatchObject({ outcome: "routed", projectId: "prj_new", provisioned: true });
  expect(deps.provisionCalls).toEqual([
    // The From HEADER is the identity — lowercased, +tags/dots untouched.
    { address: "joebloggs@gmail.com", name: "Joe Bloggs", allowProvision: true },
  ]);
  expect(deps.appended).toHaveLength(1);
  expect(deps.appended[0]).toMatchObject({
    projectId: "prj_new",
    event: {
      type: "events.iterate.com/email/received",
      idempotencyKey: "email-received:msg-1@gmail.com",
      payload: {
        recipient: { kind: "zero-onboarding", address: "bot@iterate.app" },
        from: { address: "joebloggs@gmail.com", name: "Joe Bloggs" },
        subject: "slime volleyball",
        text: "Make me a browser slime volleyball game",
        messageId: "msg-1@gmail.com",
        provisioned: true,
      },
    },
  });
});

it("drops mail whose Authentication-Results do not align with the From domain", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "attacker@evil.com",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({
        from: "Joe Bloggs <joebloggs@gmail.com>",
        // dkim passes for the ATTACKER's domain, not the spoofed From domain.
        authenticationResults: "mx.cloudflare.net; spf=pass; dkim=pass header.d=evil.com",
        subject: "give me your project",
        body: "hi",
      }),
    },
    deps.deps,
  );

  expect(result).toMatchObject({ outcome: "dropped", reason: "sender-not-verified" });
  expect(deps.provisionCalls).toHaveLength(0);
  expect(deps.appended).toHaveLength(0);
});

it("drops mail with no Authentication-Results header at all", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "joebloggs@gmail.com",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({
        from: "joebloggs@gmail.com",
        authenticationResults: null,
        subject: "hello",
        body: "hi",
      }),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "dropped", reason: "sender-not-verified" });
});

it("routes a known sender without provisioning even when zero-onboarding is disabled", async () => {
  const deps = fakeDeps({
    emailZeroOnboardingEnabled: false,
    resolveSenderProject: async (input) =>
      input.allowProvision === false && input.address === "joebloggs@gmail.com"
        ? { projectId: "prj_existing", provisioned: false }
        : null,
  });
  const result = await handleInboundEmail(
    {
      envelopeFrom: "joebloggs@gmail.com",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({ from: "joebloggs@gmail.com", subject: "again", body: "more please" }),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "routed", projectId: "prj_existing" });
});

it("drops brand-new senders when zero-onboarding is disabled", async () => {
  const deps = fakeDeps({
    emailZeroOnboardingEnabled: false,
    resolveSenderProject: async () => null,
  });
  const result = await handleInboundEmail(
    {
      envelopeFrom: "new@gmail.com",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({ from: "new@gmail.com", subject: "hi", body: "hi" }),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "dropped", reason: "zero-onboarding-disabled" });
});

it("routes project-addressed mail to the slug's project for thread continuation", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "joebloggs@gmail.com",
      envelopeTo: "joebloggs@iterate.app",
      rawMime: rawEmail({
        from: "joebloggs@gmail.com",
        subject: "Re: slime volleyball",
        body: "add sound effects",
        messageId: "msg-3@gmail.com",
        inReplyTo: "<reply-1@iterate.app>",
        references: "<msg-1@gmail.com> <reply-1@iterate.app>",
      }),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "routed", projectId: "prj_bylookup" });
  expect(deps.appended[0]!.event.payload).toMatchObject({
    recipient: { kind: "project", address: "joebloggs@iterate.app" },
    inReplyTo: "reply-1@iterate.app",
    references: ["msg-1@gmail.com", "reply-1@iterate.app"],
  });
  expect(deps.provisionCalls).toHaveLength(0);
});

it("drops mail to unknown project slugs and reserved local parts", async () => {
  const deps = fakeDeps({ lookupProjectIdBySlug: async () => null });
  expect(
    await handleInboundEmail(
      {
        envelopeFrom: "joebloggs@gmail.com",
        envelopeTo: "nosuchproject@iterate.app",
        rawMime: rawEmail({ from: "joebloggs@gmail.com", subject: "x", body: "x" }),
      },
      deps.deps,
    ),
  ).toMatchObject({ outcome: "dropped", reason: "unknown-project" });

  expect(
    await handleInboundEmail(
      {
        envelopeFrom: "joebloggs@gmail.com",
        envelopeTo: "postmaster@iterate.app",
        rawMime: rawEmail({ from: "joebloggs@gmail.com", subject: "x", body: "x" }),
      },
      deps.deps,
    ),
  ).toMatchObject({ outcome: "dropped", reason: "reserved-recipient" });

  expect(
    await handleInboundEmail(
      {
        envelopeFrom: "joebloggs@gmail.com",
        envelopeTo: "bot@somewhere-else.example",
        rawMime: rawEmail({ from: "joebloggs@gmail.com", subject: "x", body: "x" }),
      },
      deps.deps,
    ),
  ).toMatchObject({ outcome: "dropped", reason: "wrong-domain" });
});

it("drops auto-submitted and list mail before touching the directory (loop guard)", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "noreply@somewhere.example",
      envelopeTo: "bot@iterate.app",
      rawMime: rawEmail({
        from: "noreply@somewhere.example",
        subject: "Out of office",
        body: "I am away",
        extraHeaders: ["Auto-Submitted: auto-replied"],
      }),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "dropped", reason: "mail-loop-guard" });
  expect(deps.provisionCalls).toHaveLength(0);
});

it("drops oversized messages before parsing", async () => {
  const deps = fakeDeps();
  const result = await handleInboundEmail(
    {
      envelopeFrom: "joebloggs@gmail.com",
      envelopeTo: "bot@iterate.app",
      rawMime: "x".repeat(MAX_INBOUND_EMAIL_BYTES + 1),
    },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "dropped", reason: "message-too-large" });
});

it("keeps attachment metadata (never bodies) and proceeds with the text", async () => {
  const boundary = "----=_boundary_1";
  const deps = fakeDeps();
  const rawMime = [
    "From: Joe Bloggs <joebloggs@gmail.com>",
    "To: bot@iterate.app",
    "Subject: with attachment",
    "Message-ID: <msg-att@gmail.com>",
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=gmail.com",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain",
    "",
    "please read the attached spec",
    `--${boundary}`,
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="spec.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("fake pdf bytes").toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const result = await handleInboundEmail(
    { envelopeFrom: "joebloggs@gmail.com", envelopeTo: "bot@iterate.app", rawMime },
    deps.deps,
  );
  expect(result).toMatchObject({ outcome: "routed" });
  const payload = deps.appended[0]!.event.payload as { attachments: unknown; text?: string };
  expect(payload.text).toContain("please read the attached spec");
  expect(payload.attachments).toEqual([
    { filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 14 },
  ]);
});

describe("verifySenderAlignment", () => {
  const gmailFrom = { fromDomain: "gmail.com" };

  it("accepts dmarc=pass", () => {
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; spf=fail; dmarc=pass header.from=gmail.com"],
        ...gmailFrom,
      }),
    ).toEqual({ verified: true });
  });

  it("accepts aligned dkim=pass (exact and relaxed)", () => {
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; dkim=pass header.d=gmail.com"],
        ...gmailFrom,
      }),
    ).toEqual({ verified: true });
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; dkim=pass header.i=@mail.gmail.com"],
        ...gmailFrom,
      }),
    ).toEqual({ verified: true });
  });

  it("rejects unaligned dkim, spf-only, and dmarc=fail", () => {
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; dkim=pass header.d=evil.com"],
        ...gmailFrom,
      }),
    ).toMatchObject({ verified: false });
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; spf=pass smtp.mailfrom=gmail.com"],
        ...gmailFrom,
      }),
    ).toMatchObject({ verified: false });
    expect(
      verifySenderAlignment({
        authenticationResults: ["mx.cloudflare.net; dmarc=fail header.from=gmail.com"],
        ...gmailFrom,
      }),
    ).toMatchObject({ verified: false });
  });
});

describe("domainsAlignRelaxed", () => {
  it("matches equal domains and label-boundary parents", () => {
    expect(domainsAlignRelaxed("gmail.com", "gmail.com")).toBe(true);
    expect(domainsAlignRelaxed("mail.gmail.com", "gmail.com")).toBe(true);
    expect(domainsAlignRelaxed("gmail.com", "mail.gmail.com")).toBe(true);
    expect(domainsAlignRelaxed("notgmail.com", "gmail.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rawEmail(input: {
  from: string;
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** null = omit the header entirely; undefined = a passing dmarc default. */
  authenticationResults?: string | null;
  extraHeaders?: string[];
}): string {
  const fromDomain = (input.from.match(/@([^>\s]+)/)?.[1] ?? "gmail.com").toLowerCase();
  const authenticationResults =
    input.authenticationResults === undefined
      ? `mx.cloudflare.net; spf=pass; dkim=pass header.d=${fromDomain}; dmarc=pass header.from=${fromDomain}`
      : input.authenticationResults;
  return [
    `From: ${input.from}`,
    "To: bot@iterate.app",
    `Subject: ${input.subject}`,
    `Message-ID: ${input.messageId ?? "<msg-1@gmail.com>"}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    ...(authenticationResults === null ? [] : [`Authentication-Results: ${authenticationResults}`]),
    ...(input.extraHeaders ?? []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
    "",
  ].join("\r\n");
}

function fakeDeps(overrides?: {
  emailZeroOnboardingEnabled?: boolean;
  resolveSenderProject?: InboundEmailDeps["resolveSenderProject"];
  lookupProjectIdBySlug?: InboundEmailDeps["lookupProjectIdBySlug"];
}) {
  const provisionCalls: { address: string; name?: string; allowProvision: boolean }[] = [];
  const appended: {
    projectId: string;
    event: { type: string; idempotencyKey: string; payload: Record<string, unknown> };
  }[] = [];
  const deps: InboundEmailDeps = {
    config: {
      projectHostnameBases: ["iterate.app"],
      emailZeroOnboardingEnabled: overrides?.emailZeroOnboardingEnabled ?? true,
    } as AppConfig,
    resolveSenderProject: async (input) => {
      provisionCalls.push({
        address: input.address,
        ...(input.name === undefined ? {} : { name: input.name }),
        allowProvision: input.allowProvision,
      });
      if (overrides?.resolveSenderProject) return overrides.resolveSenderProject(input);
      return input.allowProvision ? { projectId: "prj_new", provisioned: true } : null;
    },
    lookupProjectIdBySlug:
      overrides?.lookupProjectIdBySlug ?? (async (slug) => (slug ? "prj_bylookup" : null)),
    appendEmailReceived: async (input) => {
      appended.push(input as (typeof appended)[number]);
    },
  };
  return { deps, provisionCalls, appended };
}
