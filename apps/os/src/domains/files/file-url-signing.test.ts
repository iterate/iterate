import { describe, expect, it } from "vitest";
import {
  buildSignedFileUrl,
  checkSignedFileRequest,
  fileUrlSignature,
  projectFileDataToBytes,
  sanitizeFileFilename,
} from "./file-url-signing.ts";

const SECRET = "test-secret";
const PROJECT_ID = "prj_test123";

async function signedUrl(input?: { expiresAtSeconds?: number; path?: string }) {
  return new URL(
    await buildSignedFileUrl({
      expiresAtSeconds: input?.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 60,
      origin: "https://iterate-files--demo.iterate.app",
      path: input?.path ?? "/agents/web/demo/abc123-cat.png",
      projectId: PROJECT_ID,
      secret: SECRET,
    }),
  );
}

describe("signed file urls", () => {
  it("round-trips: a minted url verifies to the same path", async () => {
    const url = await signedUrl({ path: "/agents/web/demo/abc123-cat.png" });
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toEqual({ ok: true, path: "/agents/web/demo/abc123-cat.png" });
  });

  it("percent-encodes path segments and verifies against the decoded path", async () => {
    const url = await signedUrl({ path: "/agents/web/demo/has space.png" });
    expect(url.pathname).toContain("has%20space.png");
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toEqual({ ok: true, path: "/agents/web/demo/has space.png" });
  });

  it("rejects expired links before touching the signature", async () => {
    const url = await signedUrl({ expiresAtSeconds: Math.floor(Date.now() / 1000) - 1 });
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toMatchObject({ message: "link expired", ok: false, status: 403 });
  });

  it("rejects a tampered path", async () => {
    const url = await signedUrl({ path: "/agents/web/demo/mine.png" });
    url.pathname = "/agents/web/demo/other.png";
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toMatchObject({ message: "invalid signature", ok: false, status: 403 });
  });

  it("rejects a stretched expiry (exp is signed)", async () => {
    const url = await signedUrl();
    url.searchParams.set("exp", String(Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60));
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toMatchObject({ message: "invalid signature", ok: false, status: 403 });
  });

  it("rejects a signature minted for another project", async () => {
    const url = await signedUrl();
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: "prj_other",
      secret: SECRET,
      url,
    });
    expect(check).toMatchObject({ message: "invalid signature", ok: false, status: 403 });
  });

  it("rejects missing signature params", async () => {
    const url = await signedUrl();
    url.searchParams.delete("sig");
    const check = await checkSignedFileRequest({
      nowMs: Date.now(),
      projectId: PROJECT_ID,
      secret: SECRET,
      url,
    });
    expect(check).toMatchObject({ message: "missing signature", ok: false, status: 403 });
  });

  it("signatures are url-safe base64", async () => {
    const signature = await fileUrlSignature({
      expiresAtSeconds: 1_900_000_000,
      path: "/x.png",
      projectId: PROJECT_ID,
      secret: SECRET,
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("projectFileDataToBytes", () => {
  it("decodes base64 strings (the Workers AI image shape)", async () => {
    const bytes = await projectFileDataToBytes(btoa("hello"));
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  it("decodes data: URLs", async () => {
    const bytes = await projectFileDataToBytes(`data:image/png;base64,${btoa("png-bytes")}`);
    expect(new TextDecoder().decode(bytes)).toBe("png-bytes");
  });

  it("rejects non-base64 strings loudly", async () => {
    await expect(projectFileDataToBytes("definitely not base64!!")).rejects.toThrow(
      /must be base64/,
    );
  });

  it("passes through Uint8Array and buffers Blob and streams", async () => {
    const raw = new TextEncoder().encode("bytes");
    expect(await projectFileDataToBytes(raw)).toBe(raw);
    expect(new TextDecoder().decode(await projectFileDataToBytes(new Blob([raw])))).toBe("bytes");
    const stream = new Blob([raw]).stream();
    expect(new TextDecoder().decode(await projectFileDataToBytes(stream))).toBe("bytes");
  });
});

describe("sanitizeFileFilename", () => {
  it("keeps safe names and strips the rest", () => {
    expect(sanitizeFileFilename("cat.png")).toBe("cat.png");
    expect(sanitizeFileFilename("my report (final).pdf")).toBe("my-report-final-.pdf");
    expect(sanitizeFileFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeFileFilename("")).toBe("file");
    expect(sanitizeFileFilename("x".repeat(200))).toHaveLength(100);
  });
});
