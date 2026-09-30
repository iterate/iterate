// src/email/sender.ts — WHO SENT AN INBOUND MESSAGE, as far as its headers tell: pure reads that
// integrations/email.ts puts on `email/received`. Cloudflare's inbound servers stamp an
// Authentication-Results header (authserv-id `mx.cloudflare.net`, RFC 8601) with their SPF, DKIM
// and DMARC verdicts. A sender can put a forged record with the same authserv-id in the message, so
// the From address counts as verified only if EVERY such record proves it: a forged pass never
// outvotes the real verdict, and a forged failure only withholds the verification.

/** One header as postal-mime parses it: its lowercased name and its unfolded value. */
type Header = { key: string; value: string };

/** Cloudflare's SPF, DKIM and DMARC verdicts (`pass`, `fail`, `none`, …, null where it gave none)
 *  from its topmost record (an MTA prepends its own); whether every Cloudflare record proves
 *  `from` (`verified`): an aligned DMARC pass, an aligned DKIM signature, or an SPF pass for an
 *  aligned envelope domain — DMARC's alignment, parent and child domains aligning; and whether
 *  every record has that SPF pass (`direct`): a DKIM signature survives anyone re-sending the
 *  message, and only SPF says the server that handed it over is the From domain's own. */
export function authenticationOf(headers: Header[], from: string) {
  const fromDomain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
  const records = headers
    .filter((header) => header.key === "authentication-results")
    .map((header) => header.value.replace(/\([^()]*\)/g, " ").split(";"))
    .filter(([authservId]) => /^\s*mx\.cloudflare\.net(?:\s+\d+)?\s*$/i.test(authservId!))
    .map(([, ...results]) =>
      results.flatMap((result) => {
        const [verdict, ...properties] = result.trim().toLowerCase().split(/\s+/);
        const [method, value] = verdict!.split("=");
        if (!method || !value) return [];
        return [
          { method, value, properties: Object.fromEntries(properties.map((p) => p.split("="))) },
        ];
      }),
    );
  const aligned = (domain: string | undefined) =>
    !!domain &&
    (domain === fromDomain ||
      domain.endsWith(`.${fromDomain}`) ||
      fromDomain.endsWith(`.${domain}`));
  const alignedSpfPass = ({ method, value, properties }: (typeof records)[number][number]) =>
    method === "spf" && value === "pass" && aligned(properties["smtp.mailfrom"]?.split("@").pop());
  const proves = (record: (typeof records)[number]) =>
    record.some(
      (result) =>
        alignedSpfPass(result) ||
        (result.value === "pass" &&
          ((result.method === "dmarc" && aligned(result.properties["header.from"] || fromDomain)) ||
            (result.method === "dkim" && aligned(result.properties["header.d"])))),
    );
  const verdictOf = (method: string) => {
    const verdicts = (records[0] ?? []).filter((result) => result.method === method);
    return verdicts.some((result) => result.value === "pass")
      ? "pass"
      : (verdicts[0]?.value ?? null);
  };
  return {
    authentication: { spf: verdictOf("spf"), dkim: verdictOf("dkim"), dmarc: verdictOf("dmarc") },
    verified: !!fromDomain && records.length > 0 && records.every(proves),
    direct: !!fromDomain && records.length > 0 && records.every((r) => r.some(alignedSpfPass)),
  };
}

/** An auto-reply, a bulk or list message, or a bounce — Auto-Submitted other than `no` (RFC 3834),
 *  Precedence `bulk`/`list`/`junk`, a delivery report (`multipart/report`), the null envelope sender
 *  bounces carry (`<>`), or mailer-daemon/postmaster in the envelope or the From header: nothing
 *  should answer it automatically. */
export function isAutomated(headers: Header[], envelopeFrom: string) {
  const valueOf = (key: string) =>
    headers
      .find((header) => header.key === key)
      ?.value.trim()
      .toLowerCase();
  const autoSubmitted = valueOf("auto-submitted");
  return (
    (!!autoSubmitted && autoSubmitted !== "no") ||
    ["bulk", "list", "junk"].includes(valueOf("precedence") ?? "") ||
    !!valueOf("content-type")?.startsWith("multipart/report") ||
    ["", "<>"].includes(envelopeFrom.trim()) ||
    [envelopeFrom, valueOf("from") ?? ""].some((address) =>
      /\b(mailer-daemon|postmaster)@/i.test(address),
    )
  );
}
