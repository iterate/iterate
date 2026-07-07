// Slack v0 request-signature verification (HMAC-SHA256 over
// `v0:<timestamp>:<body>`): https://docs.slack.dev/authentication/verifying-requests-from-slack
// Built on the shared WebCrypto HMAC + constant-time-compare primitives in
// ../secrets/utils.ts — the same pair the GitHub webhook door uses.

import { computeHmacHex, timingSafeStringEqual } from "../secrets/utils.ts";

export async function verifySlackSignature(input: {
  body: string;
  signature: string | null;
  signingSecret: string;
  timestamp: string | null;
}) {
  if (!input.signature || !input.timestamp) return false;
  const timestampNumber = Number.parseInt(input.timestamp, 10);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 60 * 5) return false;

  const digest = await computeHmacHex({
    key: input.signingSecret,
    payload: `v0:${input.timestamp}:${input.body}`,
  });
  return timingSafeStringEqual(`v0=${digest}`, input.signature);
}
