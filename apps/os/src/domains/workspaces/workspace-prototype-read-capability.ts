/** Short-lived grants for direct immutable reads through the container's trusted egress proxy. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const Grant = z.object({
  containerId: z.string().min(1),
  projectId: z.string().min(1),
  repoPath: z.string().startsWith("/repos/"),
  oid: z.string().regex(/^[a-f0-9]{40}$/),
  expiresAt: z.number().int().nonnegative(),
});
type Grant = z.infer<typeof Grant>;

function mac(secret: string, payload: string): Buffer {
  // Derive a purpose-specific MAC key; never use the encryption key directly as a signing key.
  const key = createHmac("sha256", secret)
    .update("iterate/workspace-prototype/blob-read/v1")
    .digest();
  return createHmac("sha256", key).update(payload).digest();
}

export function signPrototypeBlobRead(secret: string, grant: Grant): string {
  return mac(
    secret,
    JSON.stringify([
      grant.containerId,
      grant.projectId,
      grant.repoPath,
      grant.oid,
      grant.expiresAt,
    ]),
  ).toString("base64url");
}

export function verifyPrototypeBlobRead(
  secret: string,
  token: string,
  candidate: unknown,
  containerId: string,
  now = Date.now(),
): Grant | null {
  const parsed = Grant.safeParse(candidate);
  if (!parsed.success || parsed.data.containerId !== containerId || parsed.data.expiresAt <= now)
    return null;
  if (token.length > 64) return null;
  const expected = Buffer.from(signPrototypeBlobRead(secret, parsed.data), "base64url");
  const received = Buffer.from(token, "base64url");
  return received.length === expected.length && timingSafeEqual(received, expected)
    ? parsed.data
    : null;
}
