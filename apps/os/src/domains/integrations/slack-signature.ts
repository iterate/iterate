// Slack v0 request-signature verification (HMAC-SHA256 over
// `v0:<timestamp>:<body>`): https://docs.slack.dev/authentication/verifying-requests-from-slack
// Deliberately a leaf module — pure WebCrypto, no worker imports — so the
// node-environment unit tests can exercise it without dragging in
// `cloudflare:workers` (the webhook handler's route chain does).

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

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${input.timestamp}:${input.body}`),
  );
  const expected = `v0=${hex(new Uint8Array(signature))}`;
  return constantTimeEqual(expected, input.signature);
}

/** Encode HMAC bytes in the lowercase hex format Slack expects in v0 signatures. */
function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}
