#!/opt/node24/bin/node
/* eslint-disable no-console -- CLI script inside sandbox: console output is the user interface */
import fs from "node:fs";
import path from "node:path";

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function main() {
  const uploadUrl = process.env.ITERATE_AGENT_UPLOAD_URL || process.env.UPLOAD_FILE_URL;
  if (!uploadUrl) {
    console.error(
      "Missing environment variable ITERATE_AGENT_UPLOAD_URL (or UPLOAD_FILE_URL fallback).",
    );
    console.error("This CLI should be used inside the iterate sandbox environment.");
    process.exit(2);
  }

  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: /tmp/upload-file /absolute/or/relative/path/to/file");
    process.exit(2);
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(2);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    console.error(`Not a file: ${resolvedPath}`);
    process.exit(2);
  }

  const filename = path.basename(resolvedPath);
  const contentType = guessMimeType(resolvedPath);

  const url = new URL(uploadUrl);
  url.searchParams.set("filename", filename);

  const readStream = fs.createReadStream(resolvedPath);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
    },
    // Node/undici requires duplex when streaming a request body

    duplex: "half" as any,
    body: readStream as unknown as ReadableStream,
  } as unknown as RequestInit);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const attemptedUrl = url.toString();
    console.error(
      `Upload to ${attemptedUrl} failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`,
    );
    process.exit(res.status || 1);
  }

  const json = (await res.json().catch(() => null)) as {
    id: string;
    openAIFileId?: string;
    filename?: string;
    mimeType?: string;
  } | null;

  if (json && json.id) {
    // Print a concise, machine-readable line first for easy parsing
    console.log(`OK iterateFileId=${json.id}`);
    // Also print the full JSON response for human readability
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log("OK");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
