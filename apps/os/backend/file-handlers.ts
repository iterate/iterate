import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { typeid } from "typeid-js";
import { env, type CloudflareEnv } from "../env.ts";
import type { Variables } from "./worker.ts";
import { schema, type DB } from "./db/client.ts";
import { files } from "./db/schema.ts";
import { openAIProvider } from "./agent/openai-client.ts";
import { getBaseURL } from "./utils/utils.ts";
import { logger } from "./tag-logger.ts";

// Types
export type FileRecord = InferSelectModel<typeof files>;
export type NewFileRecord = InferInsertModel<typeof files>;

export interface UploadArgs {
  stream: ReadableStream;
  bucket: R2Bucket;
  fileId: string;
  filename: string;
  mimeType?: string;
  db: DB;
  openai: Awaited<ReturnType<typeof openAIProvider>>;
}

const startUpload = async (
  db: DB,
  fileId: string,
  installationId: string,
  filename?: string,
): Promise<FileRecord> => {
  const newFile: NewFileRecord = {
    id: fileId,
    status: "started",
    filename,
    installationId,
  };

  const [insertedFile] = await db.insert(schema.files).values(newFile).returning();

  if (!insertedFile) {
    throw new Error(`Failed to create file record: ${fileId}`);
  }

  return insertedFile;
};

const doUpload = async ({
  stream,
  bucket,
  fileId,
  filename,
  mimeType,
  db,
  openai,
}: UploadArgs): Promise<FileRecord> => {
  try {
    const [stream1, stream2] = stream.tee();
    // Upload stream directly to R2 bucket
    const r2Key = generateR2Key(fileId);
    const uploadResult = bucket.put(r2Key, stream1, {
      httpMetadata: {
        contentType: mimeType || "application/octet-stream",
      },
    });

    // Upload file to OpenAI
    // Note: the openai library requires us to buffer the request in memory
    const fileBlob = await new Response(stream2).blob();

    const openAIFile = await openai.files.create({
      file: new File([fileBlob], filename, {
        type: mimeType || "application/octet-stream",
      }),
      purpose: "user_data",
    });

    // Get file size from the r2 upload result
    const r2Object = await uploadResult;
    const fileSize = r2Object.size;

    const [updatedFile] = await db
      .update(schema.files)
      .set({
        status: "completed",
        filename,
        fileSize,
        mimeType,
        openAIFileId: openAIFile.id,
      })
      .where(eq(files.id, fileId))
      .returning();

    if (!updatedFile) {
      throw new Error(`File record not found: ${fileId}`);
    }

    return {
      ...updatedFile,
      openAIFileId: updatedFile.openAIFileId || openAIFile.id, // ensure that it is typed as string even though the db schema has it as nnu
    };
  } catch (error) {
    // Update status to indicate failure
    await db
      .update(schema.files)
      .set({
        status: "error",
      })
      .where(eq(files.id, fileId));

    throw new Error(`Failed to upload file ${fileId}`, { cause: error });
  }
};

// Helper function to generate file IDs
const generateFileId = () => typeid("file").toString();

// Helper function to generate R2 key for a file
const generateR2Key = (fileId: string) => `files/${fileId}`;

export const uploadFileHandler = async (
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) => {
  try {
    const db = c.var.db;
    if (!db) {
      return c.json({ error: "Database unavailable" }, 500);
    }

    const installationId = c.req.param("installationId");
    if (!installationId) {
      return c.json({ error: "installationId parameter is required" }, 400);
    }

    const filename = c.req.query("filename");
    if (!filename) {
      return c.json({ error: "filename query parameter is required" }, 400);
    }
    const contentType = c.req.header("content-type") || "application/octet-stream";
    const stream = c.req.raw.body!;
    const contentLength = c.req.header("content-length")
      ? Number.parseInt(c.req.header("content-length")!)
      : 0; // we really ought to return a 400 error if someone sends us a request without a content-length header but we will try it anyway
    const fileRecord = await uploadFile({
      stream,
      contentLength,
      filename,
      contentType,
      installationId,
      db,
    });
    return c.json(fileRecord);
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : "Upload failed",
      },
      500,
    );
  }
};

export const uploadFileFromURL = async ({
  url,
  filename,
  headers,
  installationId,
  db,
}: {
  url: string;
  filename: string;
  headers?: Record<string, string>;
  installationId: string;
  db: DB;
}): Promise<FileRecord> => {
  // Fetch the file from URL
  const response = await fetch(url, headers ? { headers } : {});
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";

  const contentLength = response.headers.get("content-length")
    ? Number.parseInt(response.headers.get("content-length")!)
    : 0;
  if (!contentLength) {
    // TODO: we could consider reading into memory here to get the content length
    logger.error("content-length header is missing, will try without it anyway");
  }

  const fileRecord = await uploadFile({
    stream: response.body!,
    contentLength,
    filename,
    contentType,
    installationId,
    db,
  });

  return fileRecord;
};

export function getFilePublicURL(iterateFileId: string) {
  return `${getBaseURL({ replaceLocalhostWithNgrok: true })}/api/files/${iterateFileId}`;
}

export async function getFileContent(params: {
  iterateFileId: string;
  db: DB;
  installationId: string;
}) {
  const { iterateFileId, db, installationId } = params;

  // Get file record from database
  const [fileRecord] = await db.select().from(files).where(eq(files.id, iterateFileId)).limit(1);

  if (!fileRecord) {
    throw new Error(`File not found: ${iterateFileId}`);
  }

  // Verify the file belongs to the specified estate
  if (fileRecord.installationId !== installationId) {
    throw new Error(`File ${iterateFileId} does not belong to estate ${installationId}`);
  }

  if (fileRecord.status !== "completed") {
    throw new Error(`File upload not completed for ${iterateFileId}`);
  }

  // Get file from R2
  const r2Key = generateR2Key(iterateFileId);
  const object = await env.ITERATE_FILES.get(r2Key);

  if (!object) {
    throw new Error(`File not found in storage: ${iterateFileId}`);
  }

  // Get content as stream
  const stream = object.body;

  if (!stream) {
    throw new Error(`File stream not available: ${iterateFileId}`);
  }

  return {
    content: stream,
    fileRecord,
  };
}

export const uploadFile = async ({
  stream,
  contentLength,
  filename,
  contentType,
  installationId,
  db,
}: {
  filename: string;
  contentType: string;
  installationId: string;
  db: DB;
} & (
  | {
      stream: ReadableStream;
      contentLength: number;
    }
  | {
      stream: Uint8Array;
      contentLength?: never;
    }
)) => {
  const fileId = generateFileId();

  if (stream instanceof Uint8Array) {
    // have to do fixed length stream here because cloudflare agent doesn't support streaming
    const { readable, writable } = new FixedLengthStream(stream.length);
    const sourceStream = new ReadableStream({
      start(controller) {
        controller.enqueue(stream);
        controller.close();
      },
    });
    sourceStream.pipeTo(writable).catch((err) => logger.error("FixedLengthStream error:", err));
    stream = readable;
  } else {
    if (!contentLength) {
      // _sometimes_ this works, in cloudflare it depends on where the ReadableStream is created
      logger.error("content-length header is missing. Trying anyway without it");
    } else {
      const { readable, writable } = new FixedLengthStream(contentLength);
      stream.pipeTo(writable).catch((err) => logger.error("FixedLengthStream error:", err));
      stream = readable;
    }
  }

  try {
    // Start the upload process
    await startUpload(db, fileId, installationId, filename);
    // Get the estate name for tracking purposes
    const estate = await db.query.installation.findFirst({
      where: eq(schema.installation.id, installationId),
    });
    if (!estate) {
      throw new Error(`Estate not found: ${installationId}`);
    }
    // Upload the file
    const fileRecord = await doUpload({
      stream,
      bucket: env.ITERATE_FILES,
      fileId,
      filename,
      mimeType: contentType,
      db,
      openai: await openAIProvider({
        env: {
          BRAINTRUST_API_KEY: env.BRAINTRUST_API_KEY,
          OPENAI_API_KEY: env.OPENAI_API_KEY,
          ...(env.POSTHOG_PUBLIC_KEY && {
            POSTHOG_PUBLIC_KEY: env.POSTHOG_PUBLIC_KEY,
          }),
        },
        estateName: estate.name,
      }),
    });

    return fileRecord;
  } catch (error) {
    logger.error("Upload error:", error);
    throw error;
  }
};

export const uploadFileFromURLHandler = async (
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) => {
  const installationId = c.req.param("installationId");
  const url = c.req.query("url");
  const filename = c.req.query("filename");

  if (!installationId) {
    return c.json({ error: "installationId parameter is required" }, 400);
  }

  if (!url) {
    return c.json({ error: "url query parameter is required" }, 400);
  }

  if (!filename) {
    return c.json({ error: "filename query parameter is required" }, 400);
  }

  try {
    const db = c.var.db;
    if (!db) {
      return c.json({ error: "Database unavailable" }, 500);
    }

    const fileRecord = await uploadFileFromURL({ url, filename, installationId, db });
    return c.json(fileRecord);
  } catch (error) {
    logger.error("Upload from URL error:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Upload from URL failed",
      },
      500,
    );
  }
};

export const getFileHandler = async (
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) => {
  const fileId = c.req.param("id").replace(".png", "");
  const disposition = c.req.query("disposition") || "inline";

  const db = c.var.db;
  if (!db) {
    return c.json({ error: "Database unavailable" }, 500);
  }

  try {
    // Get file record from database
    const [fileRecord] = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (!fileRecord) {
      logger.error(`[getFileHandler] File not found in database: ${fileId}`);
      return c.json({ error: "File not found" }, 404);
    }

    if (fileRecord.status !== "completed") {
      return c.json({ error: "File upload not completed" }, 400);
    }

    // Construct R2 key from file ID
    const r2Key = generateR2Key(fileId);

    // Get file from R2
    const object = await c.env.ITERATE_FILES.get(r2Key);
    if (!object) {
      return c.json({ error: "File not found in storage" }, 404);
    }

    // Return the file with appropriate headers
    const headers = new Headers();
    headers.set("Content-Type", fileRecord.mimeType || "application/octet-stream");

    // Use the disposition query parameter to control inline vs attachment
    const validDisposition = disposition === "inline" ? "inline" : "attachment";
    headers.set("Content-Disposition", `${validDisposition}; filename="${fileRecord.filename}"`);

    if (object.httpEtag) {
      headers.set("ETag", object.httpEtag);
    }

    return new Response(object.body, { headers });
  } catch (error) {
    logger.error("File retrieval error:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "File retrieval failed",
      },
      500,
    );
  }
};

export const getExportHandler = async (
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
) => {
  const exportId = c.req.param("exportId");
  const installationId = c.req.param("installationId");

  try {
    const r2Key = `exports/${exportId}.zip`;

    const object = await c.env.ITERATE_FILES.get(r2Key);
    if (!object) {
      return c.json({ error: "Export not found" }, 404);
    }

    if (object.customMetadata?.installationId !== installationId) {
      return c.json({ error: "Export not found for this estate" }, 404);
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/zip");
    headers.set("Content-Disposition", `attachment; filename="agent-trace-${exportId}.zip"`);

    if (object.httpEtag) {
      headers.set("ETag", object.httpEtag);
    }

    return new Response(object.body, { headers });
  } catch (error) {
    logger.error("Export retrieval error:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Export retrieval failed",
      },
      500,
    );
  }
};
