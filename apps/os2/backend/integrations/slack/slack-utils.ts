import { createHmac, timingSafeEqual } from "node:crypto";

export async function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const computedSignature = `v0=${hmac.digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(computedSignature, "utf8"));
  } catch {
    return false;
  }
}

export function isTimestampValid(timestamp: string, toleranceSeconds = 300): boolean {
  const requestTime = parseInt(timestamp, 10);
  const currentTime = Math.floor(Date.now() / 1000);
  return Math.abs(currentTime - requestTime) <= toleranceSeconds;
}
