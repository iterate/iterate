import { pgTable } from "drizzle-orm/pg-core";
import { typeid } from 'typeid-js';

export const files = pgTable("files", (t) => ({
    iterateId: t
      .text("id")
      .primaryKey()
      .$defaultFn(() => typeid("file").toString()),
  
    // File status
    status: t
      .text({ enum: ["started", "completed", "error"] })
      .notNull()
      .default("started"),
  
    // File information
    filename: t.text(),
    fileSize: t.integer(), // Size in bytes
    mimeType: t.text(),
  
    // OpenAI integration
    openAIFileId: t.text("open_ai_file_id"),
  
    // Timestamps
    uploadedAt: t.timestamp("uploaded_at"),

    estateId: t.text("estate_id"),
  
  }));