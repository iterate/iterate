// file-url-signing.ts — the pure half of project file storage: byte coercion,
// filename sanitizing, and the HMAC scheme behind signed public file URLs.
// No platform imports, so it unit-tests in plain Node; the env-bound wrappers
// (bucket I/O, URL minting, the serving lane) live in project-files.ts.

/**
 * Bytes accepted by every file-writing surface. Strings are ALWAYS treated as
 * base64 (optionally a full `data:` URL) — that is what Workers AI image
 * models return, and the whole point of accepting strings is piping
 * `itx.ai.run` output straight into storage.
 */
export type FileData = string | ArrayBuffer | Uint8Array | Blob | ReadableStream;

/** Normalizes a path to a leading-slash form (mirrors durable-object-names). */
function normalizeFilePath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

/** Coerces every accepted input shape to bytes. Streams and blobs are fully
 * buffered — v1 files are megabytes, and buffering sidesteps R2's
 * known-length requirement for streaming puts. */
export async function projectFileDataToBytes(data: FileData): Promise<Uint8Array> {
  if (typeof data === "string") {
    const base64 = data.startsWith("data:") ? (data.split(",", 2)[1] ?? "") : data;
    try {
      const binary = atob(base64.trim());
      return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
    } catch {
      throw new Error(
        "String file data must be base64 (or a data: URL). To store text, encode it first.",
      );
    }
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(await new Response(data).arrayBuffer());
}

/** `cat photo.PNG!!` -> `cat-photo.PNG`: keeps names key- and header-safe. */
export function sanitizeFileFilename(filename: string): string {
  const trimmed = filename
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/^[.-]+/g, "");
  return (trimmed || "file").slice(0, 100);
}

/** The HMAC over (projectId, path, object version, expiry) that authorizes a public fetch. */
export async function fileUrlSignature(input: {
  expiresAtSeconds: number;
  path: string;
  projectId: string;
  secret: string;
  version: string;
}): Promise<string> {
  // Domain-separated reuse of the deployment's encryption key — same pattern
  // as oauth-state.ts, and no new per-env secret to provision.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`project-file-url:${input.secret}`),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const payload =
    `${input.projectId}\n${normalizeFilePath(input.path)}\n${input.version}\n` +
    input.expiresAtSeconds;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Appends `exp`/`sig` query auth to an origin+path, yielding the public URL. */
export async function buildSignedFileUrl(input: {
  expiresAtSeconds: number;
  origin: string;
  path: string;
  projectId: string;
  secret: string;
  version: string;
}): Promise<string> {
  const path = normalizeFilePath(input.path);
  const url = new URL(input.origin + path.split("/").map(encodeURIComponent).join("/"));
  url.searchParams.set("exp", String(input.expiresAtSeconds));
  url.searchParams.set("ver", input.version);
  url.searchParams.set(
    "sig",
    await fileUrlSignature({
      expiresAtSeconds: input.expiresAtSeconds,
      path,
      projectId: input.projectId,
      secret: input.secret,
      version: input.version,
    }),
  );
  return url.toString();
}

/**
 * Verifies one signed-URL request: expiry first, then a constant-time HMAC
 * check. Returns the decoded file path on success; a ready-to-serve status +
 * message otherwise. Pure — the serving lane wraps it with bucket I/O.
 */
export async function checkSignedFileRequest(input: {
  nowMs: number;
  projectId: string;
  secret: string;
  url: URL;
}): Promise<
  { ok: true; path: string; version: string } | { message: string; ok: false; status: number }
> {
  const path = normalizeFilePath(decodeURIComponent(input.url.pathname));
  const expiresAtSeconds = Number(input.url.searchParams.get("exp"));
  const signature = input.url.searchParams.get("sig");
  const version = input.url.searchParams.get("ver");
  if (!signature || !version || !Number.isFinite(expiresAtSeconds)) {
    return { message: "missing signature", ok: false, status: 403 };
  }
  if (expiresAtSeconds * 1000 < input.nowMs) {
    return { message: "link expired", ok: false, status: 403 };
  }
  const expected = await fileUrlSignature({
    expiresAtSeconds,
    path,
    projectId: input.projectId,
    secret: input.secret,
    version,
  });
  if (!constantTimeEqual(signature, expected)) {
    return { message: "invalid signature", ok: false, status: 403 };
  }
  return { ok: true, path, version };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
