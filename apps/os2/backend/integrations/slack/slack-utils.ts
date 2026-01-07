import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Slack request signature
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  // Check timestamp is within 5 minutes
  const timestampNum = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > 60 * 5) {
    return false;
  }

  // Compute signature
  const sigBaseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(sigBaseString);
  const mySignature = `v0=${hmac.digest("hex")}`;

  // Compare signatures using timing-safe comparison
  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Parse Slack event type from payload
 */
export function getSlackEventType(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "unknown";
  }

  const p = payload as Record<string, unknown>;

  // URL verification challenge
  if (p.type === "url_verification") {
    return "url_verification";
  }

  // Event callback
  if (p.type === "event_callback" && typeof p.event === "object" && p.event !== null) {
    const event = p.event as Record<string, unknown>;
    const eventType = event.type as string;
    const subtype = event.subtype as string | undefined;
    return subtype ? `slack.${eventType}.${subtype}` : `slack.${eventType}`;
  }

  // Interactive component
  if (p.type === "block_actions" || p.type === "view_submission" || p.type === "shortcut") {
    return `slack.interactive.${p.type}`;
  }

  // Slash command
  if (p.command) {
    return "slack.slash_command";
  }

  return `slack.${p.type || "unknown"}`;
}
