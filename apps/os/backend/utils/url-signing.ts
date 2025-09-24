import { z } from "zod";

/**
 * Signs a URL with an expiration timestamp and signature
 */
export async function signUrl(
  url: string,
  signingKey: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const urlObj = new URL(url);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  // Add expiration to URL
  urlObj.searchParams.set("expires", expiresAt.toString());

  // Create signature payload
  const payload = `${urlObj.pathname}${urlObj.search}&expires=${expiresAt}`;

  // Create signature using Web Crypto API
  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  // Convert signature to hex string
  const signatureHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Add signature to URL
  urlObj.searchParams.set("signature", signatureHex);
  urlObj.protocol = "https";
  return urlObj.toString();
}

/**
 * Verifies a signed URL
 */
export async function verifySignedUrl(url: string, signingKey: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const expires = urlObj.searchParams.get("expires");
    const signature = urlObj.searchParams.get("signature");

    if (!expires || !signature) {
      return false;
    }

    // Check expiration
    const expiresAt = parseInt(expires, 10);
    if (Math.floor(Date.now() / 1000) > expiresAt) {
      return false;
    }

    // Remove signature from URL to recreate payload
    urlObj.searchParams.delete("signature");
    const payload = `${urlObj.pathname}${urlObj.search}&expires=${expires}`;

    // Recreate signature
    const encoder = new TextEncoder();
    const keyData = encoder.encode(signingKey);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const expectedSignature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

    // Convert expected signature to hex string
    const expectedSignatureHex = Array.from(new Uint8Array(expectedSignature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Compare signatures
    return signature === expectedSignatureHex;
  } catch {
    return false;
  }
}

// Schema for build callback payload
export const BuildCallbackPayload = z.object({
  buildId: z.string(),
  estateId: z.string(),
  success: z.boolean(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number(),
});

export type BuildCallbackPayload = z.infer<typeof BuildCallbackPayload>;
