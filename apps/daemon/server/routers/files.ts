/**
 * Files Router
 *
 * Serves files from the machine filesystem and accepts uploads.
 * Used by web-chat to let agents send files (by URL) and users upload files.
 *
 * - GET /read/* — serve any file by absolute path
 * - POST /upload — accept multipart file upload, write to /tmp/web-chat-uploads/
 */
import { createReadStream, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { nanoid } from "nanoid";

const logger = console;

const UPLOAD_DIR = "/tmp/web-chat-uploads";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "text/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

export const filesRouter = new Hono();

/**
 * Serve any file from the filesystem by absolute path.
 * Path comes after /read/ — e.g. GET /read/home/iterate/output.png
 *
 * Query params:
 *   ?download=1 — force Content-Disposition: attachment
 */
filesRouter.get("/read/*", async (c) => {
  // Extract the file path from the URL — everything after /read/
  // c.req.path returns the full path (including base from app.route()), so use URL to find /read/ reliably
  const url = new URL(c.req.url);
  const readIdx = url.pathname.indexOf("/read/");
  const rawPath = readIdx >= 0 ? url.pathname.slice(readIdx + "/read/".length) : "";
  const filePath = resolve("/", decodeURIComponent(rawPath));
  logger.log("[files] Serving", { requestPath: c.req.path, rawPath, filePath });

  if (!rawPath) {
    return c.json({ error: "No file path specified" }, 400);
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return c.json({ error: "Not a file" }, 404);
    }

    const mime = getMimeType(filePath);
    const fileName = basename(filePath);
    const forceDownload = c.req.query("download") === "1";

    const disposition = forceDownload ? `attachment; filename="${fileName}"` : "inline";

    const stream = createReadStream(filePath);
    const webStream = Readable.toWeb(stream) as ReadableStream;

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": stat.size.toString(),
        "Content-Disposition": disposition,
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return c.json({ error: "File not found", path: filePath }, 404);
    }
    if (code === "EACCES") {
      return c.json({ error: "Permission denied", path: filePath }, 403);
    }
    logger.error("[files] Error serving file", filePath, error);
    return c.json({ error: "Internal error" }, 500);
  }
});

/**
 * Accept multipart file upload. Writes to /tmp/web-chat-uploads/{id}-{filename}.
 * Returns the file path and a URL to retrieve it.
 */
filesRouter.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || typeof file === "string") {
      return c.json({ error: "No file provided. Send as multipart with field name 'file'." }, 400);
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const id = nanoid(12);
    const originalName = file.name || "upload";
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const fileName = `${id}-${safeName}`;
    const filePath = join(UPLOAD_DIR, fileName);

    const arrayBuffer = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(arrayBuffer));

    logger.log("[files] Uploaded", filePath, `(${arrayBuffer.byteLength} bytes)`);

    return c.json({
      success: true,
      filePath,
      fileName: originalName,
      size: arrayBuffer.byteLength,
      mimeType: file.type || getMimeType(originalName),
    });
  } catch (error) {
    logger.error("[files] Upload error", error);
    return c.json({ error: "Upload failed" }, 500);
  }
});
