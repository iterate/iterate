// Email helpers — thread ID derivation, event appending, thread mapping.

import { createEventsClient } from "@iterate-com/events-contract/sdk";

interface EmailEnv {
  DB: D1Database;
  EVENTS_BASE_URL: string;
}

export function slugifyMessageId(messageId: string): string {
  const cleaned = messageId.replace(/^<|>$/g, "").split("@")[0];
  return cleaned
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .slice(0, 64);
}

export function extractMessageIds(references?: string | null, inReplyTo?: string | null): string[] {
  const ids: string[] = [];
  if (references) {
    const refs = references.match(/<[^>]+>/g);
    if (refs) ids.push(...refs);
  }
  if (inReplyTo) {
    const cleaned = inReplyTo.trim();
    if (cleaned && !ids.includes(cleaned)) ids.push(cleaned);
  }
  return ids;
}

export async function deriveThreadId(
  db: D1Database,
  messageId: string | null,
  references?: string | null,
  inReplyTo?: string | null,
): Promise<string> {
  const refIds = extractMessageIds(references, inReplyTo);

  for (const refId of refIds) {
    const cleaned = refId.replace(/^<|>$/g, "");
    const row = await db
      .prepare("SELECT thread_root_message_id FROM email_thread_map WHERE outbound_message_id = ?")
      .bind(cleaned)
      .first<{ thread_root_message_id: string }>();
    if (row) {
      console.log(`[Thread] resolved outbound ${cleaned} → root ${row.thread_root_message_id}`);
      return slugifyMessageId(row.thread_root_message_id);
    }
  }

  if (refIds.length > 0) return slugifyMessageId(refIds[0]);
  if (messageId) return slugifyMessageId(messageId);
  return "unknown";
}

export async function storeThreadMapping(
  db: D1Database,
  outboundMessageId: string,
  threadRootMessageId: string,
  projectSlug: string,
) {
  const cleaned = outboundMessageId.replace(/^<|>$/g, "");
  await db
    .prepare(
      "INSERT OR REPLACE INTO email_thread_map (outbound_message_id, thread_root_message_id, project_slug) VALUES (?, ?, ?)",
    )
    .bind(cleaned, threadRootMessageId, projectSlug)
    .run();
  console.log(`[Thread] stored mapping: ${cleaned} → ${threadRootMessageId}`);
}

function getEventsClient(env: EmailEnv, projectSlug: string) {
  const baseUrl = env.EVENTS_BASE_URL ?? "https://events.iterate.com";
  return createEventsClient(`https://${projectSlug}.${baseUrl.replace(/^https?:\/\//, "")}`);
}

export async function appendEmailEvent(
  env: EmailEnv,
  projectSlug: string,
  threadId: string,
  type: "email-received" | "email-sent",
  payload: Record<string, unknown>,
) {
  try {
    const client = getEventsClient(env, projectSlug);
    const path = `/agents/email/${threadId}`;
    console.log(`[Events] appending ${type} to ${path}`);
    const result = await client.append({
      path,
      event: { type, payload },
    });
    console.log(`[Events] appended offset=${result.event.offset}`);
  } catch (e: any) {
    console.error(`[Events] append failed: ${e.message}`);
  }
}
