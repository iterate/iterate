// src/email/sender.test.ts — sender.ts's executable spec: which Authentication-Results prove a
// From address, and which messages are automated.
import { expect, test } from "vitest";
import { authenticationOf, isAutomated } from "./sender.ts";

test.for([
  {
    row: "Cloudflare's aligned passes verify the sender",
    headers: [results(cloudflarePasses())],
    from: "ann@example.com",
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    verified: true,
    direct: true,
  },
  {
    row: "an aligned DKIM signature verifies a domain that publishes no DMARC",
    headers: [
      results(
        "mx.cloudflare.net; dkim=pass header.d=mail.example.com; dmarc=none header.from=example.com; spf=none",
      ),
    ],
    from: "ann@example.com",
    authentication: { spf: "none", dkim: "pass", dmarc: "none" },
    verified: true,
  },
  {
    row: "an SPF pass for the sender's own envelope domain verifies it",
    headers: [
      results(
        "mx.cloudflare.net; dkim=none; dmarc=none; spf=pass smtp.mailfrom=bounces@example.com",
      ),
    ],
    from: "ann@example.com",
    authentication: { spf: "pass", dkim: "none", dmarc: "none" },
    verified: true,
    direct: true,
  },
  {
    row: "passes for another domain than the From address's prove nothing",
    headers: [
      results(
        "mx.cloudflare.net; dkim=pass header.d=mailer.test; dmarc=none header.from=example.com; spf=pass smtp.mailfrom=x@mailer.test",
      ),
    ],
    from: "ann@example.com",
    authentication: { spf: "pass", dkim: "pass", dmarc: "none" },
    verified: false,
  },
  {
    row: "a look-alike domain is not aligned",
    headers: [results("mx.cloudflare.net; dkim=pass header.d=evilexample.com; dmarc=none")],
    from: "ann@example.com",
    authentication: { spf: null, dkim: "pass", dmarc: "none" },
    verified: false,
  },
  {
    row: "a forged Cloudflare pass below the real failure does not verify",
    headers: [
      results("mx.cloudflare.net; dkim=none; dmarc=none header.from=example.com; spf=softfail"),
      results(cloudflarePasses()),
    ],
    from: "ann@example.com",
    authentication: { spf: "softfail", dkim: "none", dmarc: "none" },
    verified: false,
  },
  {
    row: "a record from another server is not Cloudflare's",
    headers: [results("mx.cloudflare.net.evil; dmarc=pass header.from=example.com")],
    from: "ann@example.com",
    authentication: { spf: null, dkim: null, dmarc: null },
    verified: false,
  },
  {
    row: "no Cloudflare record verifies nothing",
    headers: [{ key: "subject", value: "Hi" }],
    from: "ann@example.com",
    authentication: { spf: null, dkim: null, dmarc: null },
    verified: false,
  },
  {
    row: "a replayed message: its DKIM signature survives, the replaying server's SPF does not align",
    headers: [
      results(
        "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=relay@replayer.test",
      ),
    ],
    from: "ann@example.com",
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    verified: true,
    direct: false,
  },
])(
  "the sender's authentication — $row",
  ({ headers, from, authentication, verified, direct = false }) =>
    expect(authenticationOf(headers, from)).toEqual({ authentication, verified, direct }),
);

test.for([
  { row: "a person's message", headers: [], envelopeFrom: "ann@example.com", automated: false },
  {
    row: "an auto-reply",
    headers: [{ key: "auto-submitted", value: "auto-replied" }],
    envelopeFrom: "ann@example.com",
    automated: true,
  },
  {
    row: "Auto-Submitted: no",
    headers: [{ key: "auto-submitted", value: "no" }],
    envelopeFrom: "ann@example.com",
    automated: false,
  },
  {
    row: "a list message",
    headers: [{ key: "precedence", value: "list" }],
    envelopeFrom: "ann@example.com",
    automated: true,
  },
  {
    row: "a bounce from the mailer daemon's envelope",
    headers: [],
    envelopeFrom: "MAILER-DAEMON@example.com",
    automated: true,
  },
  { row: "a bounce with the null envelope sender", headers: [], envelopeFrom: "", automated: true },
  { row: "a bounce with <> as its sender", headers: [], envelopeFrom: "<>", automated: true },
  {
    row: "a bounce whose From header is the mailer daemon",
    headers: [{ key: "from", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" }],
    envelopeFrom: "bounces@example.com",
    automated: true,
  },
  {
    row: "a delivery report",
    headers: [
      { key: "content-type", value: 'multipart/report; report-type=delivery-status; boundary="x"' },
    ],
    envelopeFrom: "bounces@example.com",
    automated: true,
  },
])("automated mail — $row", ({ headers, envelopeFrom, automated }) =>
  expect(isAutomated(headers, envelopeFrom)).toBe(automated),
);

function results(value: string) {
  return { key: "authentication-results", value };
}

/** Cloudflare's record for mail from ann@example.com that passes all three. */
function cloudflarePasses() {
  return "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=AbC=; dmarc=pass header.from=example.com policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of ann@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=ann@example.com; arc=none smtp.remote-ip=1.2.3.4";
}
