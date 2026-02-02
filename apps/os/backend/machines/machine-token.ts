import { and, eq, isNull } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { decrypt, encrypt } from "../utils/encryption.ts";

// Generate a project access token API key
// Format: pak_<tokenId>_<randomHex>
export function generateProjectAccessKey(tokenId: string): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const randomHex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pak_${tokenId}_${randomHex}`;
}

/**
 * Get or create the project-level access token for machines.
 * Returns the token ID and decrypted API key.
 * If a token doesn't exist, creates one.
 */
export async function getOrCreateProjectMachineToken(
  db: DB,
  projectId: string,
): Promise<{ tokenId: string; apiKey: string }> {
  // Look for an existing non-revoked token for the project
  const existingToken = await db.query.projectAccessToken.findFirst({
    where: and(
      eq(schema.projectAccessToken.projectId, projectId),
      isNull(schema.projectAccessToken.revokedAt),
    ),
    orderBy: (token, { asc }) => [asc(token.createdAt)], // Get oldest (first created) token
  });

  if (existingToken) {
    // Decrypt and return the existing token
    const apiKey = await decrypt(existingToken.encryptedToken);
    return { tokenId: existingToken.id, apiKey };
  }

  // No existing token - create a new one
  const tokenId = typeid("pat").toString();
  const apiKey = generateProjectAccessKey(tokenId);
  const encryptedToken = await encrypt(apiKey);

  await db.insert(schema.projectAccessToken).values({
    id: tokenId,
    projectId,
    name: "Machine Access Token",
    encryptedToken,
  });

  return { tokenId, apiKey };
}
