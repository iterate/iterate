// Tombstone for the deleted codemode domain (itx-next.md §4).
//
// The CLASS must keep existing: production streams carry durable callable
// subscribers that dial the CODEMODE_SESSION binding by name (see the
// 2026-06-10 legacy-subscriber incident for what happens when a configured
// subscriber's target vanishes). This stub accepts those dials and does
// nothing; instances and their SQLite remain until a cleanup pass removes
// the namespace with a proper Durable Object deletion migration.

import { DurableObject } from "cloudflare:workers";

export class CodemodeSession extends DurableObject {
  async requestStreamSubscription(): Promise<void> {
    console.warn(
      `[codemode-tombstone] ignoring stream subscription dial for ${this.ctx.id.name ?? this.ctx.id.toString()} — codemode was removed; clean up the stream's subscriber events.`,
    );
  }
}
