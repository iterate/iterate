import { DurableObject } from "cloudflare:workers";
import { sql } from "drizzle-orm/sql/sql";
import { z } from "zod/v4";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { getDb, schema } from "../db/client.ts";
import { invalidateOrganizationQueries } from "../utils/websocket-utils.ts";

// Messages sent to admin/watch clients
type BroadcastMessage =
  | { type: "CONNECTED"; buildId: string }
  | { type: "LOG"; buildId: string; stream: "stdout" | "stderr"; message: string; ts: number }
  | { type: "STATUS"; buildId: string; status: "in_progress" | "complete" | "failed"; ts: number };

export class EstateBuildTracker extends DurableObject {
  declare env: CloudflareEnv;

  // In-memory maps (non-authoritative; persisted state lives in storage/sql)
  private watchersByBuildId: Map<string, Set<WebSocket>> = new Map();

  constructor(ctx: any, env: CloudflareEnv) {
    super(ctx, env);

    // Rehydrate any hibernated WebSockets into our in-memory maps (tags required)
    this.ctx.getWebSockets().forEach((ws) => {
      const tags: string[] = (this.ctx as any).getTags(ws);
      const buildTag = tags.find((t) => t.startsWith("build:"));
      if (!buildTag) return;
      const buildId = buildTag.slice("build:".length);
      const watchers = this.watchersByBuildId.get(buildId) || new Set<WebSocket>();
      watchers.add(ws);
      this.watchersByBuildId.set(buildId, watchers);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Lazy initialize storage (tables etc.)
    await this.ensureInitialized();

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      return this.handleIngest(request);
    }

    if (url.pathname === "/logs" && request.method === "GET") {
      return this.handleGetLogs(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleIngest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const buildId = url.searchParams.get("buildId");
      const estateId = url.searchParams.get("estateId");
      if (!buildId) return new Response("Missing buildId", { status: 400 });
      if (!estateId) return new Response("Missing estateId", { status: 400 });

      const body = (await request.json()) as unknown;
      const LogEntry = z.object({
        seq: z.number(),
        ts: z.number(),
        stream: z.enum(["stdout", "stderr"]),
        message: z.string(),
        event: z
          .enum(["BUILD_STARTED", "BUILD_SUCCEEDED", "BUILD_FAILED", "CONFIG_OUTPUT"])
          .optional(),
      });
      const BodySchema = z
        .object({ logs: z.array(LogEntry).default([]) })
        .catch({ logs: [] as Array<z.infer<typeof LogEntry>> });
      const parsed = BodySchema.safeParse(body);
      if (!parsed.success) return new Response("Invalid payload", { status: 400 });
      const logs = parsed.data.logs;

      // Determine last processed sequence from SQL (no KV)
      let lastSeq = 0;
      try {
        const rows = this.ctx.storage.sql.exec(
          "SELECT MAX(seq) AS max_seq FROM logs WHERE build_id = ?",
          buildId,
        );
        if (Array.isArray(rows) && rows.length > 0) {
          const maxSeqVal = (rows[0] as any)?.max_seq;
          if (maxSeqVal !== null && maxSeqVal !== undefined) lastSeq = Number(maxSeqVal) || 0;
        }
      } catch (_err) {
        // default to 0
      }

      // Process in ascending seq order and insert only newer entries
      logs.sort((a, b) => a.seq - b.seq);
      let newLast = lastSeq;
      let processedAny = false;
      let status: "none" | "in_progress" | "complete" | "failed" = "none";
      for (const entry of logs
        .filter((e) => typeof e.seq === "number" && e.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq)) {
        const ts = Number(entry.ts) || Date.now();
        const stream = entry.stream === "stderr" ? "stderr" : "stdout";
        const message = String(entry.message ?? "");
        try {
          this.ctx.storage.sql.exec(
            "INSERT INTO logs (build_id, seq, ts, stream, message, event) VALUES (?, ?, ?, ?, ?, ?)",
            buildId,
            entry.seq,
            ts,
            stream,
            message,
            entry.event ?? null,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Ignore duplicates (idempotency on repeated batches)
          if (msg.includes("UNIQUE") || msg.includes("constraint")) continue;
          throw err;
        }
        this.broadcast({ type: "LOG", buildId, stream, message, ts });
        // Handle typed config output event immediately
        if (entry.event === "CONFIG_OUTPUT") {
          await this._upsertIterateConfigFromEvent(estateId, message);
        }
        newLast = entry.seq;
        processedAny = true;
        if (entry.event === "BUILD_SUCCEEDED") status = "complete";
        else if (entry.event === "BUILD_FAILED") status = "failed";
        else if (entry.event === "BUILD_STARTED" && status === "none") status = "in_progress";
      }
      await this.touchHeartbeat(buildId);
      // Remember mapping for DB updates triggered by alarms
      await this.ctx.storage.put(`estate_for_build:${buildId}`, estateId);

      // Ensure DB status reflects reality (source of truth is DO)
      const statusKey = `status:${buildId}`;
      const prevStatus = (await this.ctx.storage.get<string>(statusKey)) || null;
      // Compute desired status and update if changed
      const desiredStatus: "in_progress" | "complete" | "failed" | null =
        status === "none" ? (processedAny || logs.length === 0 ? "in_progress" : null) : status;
      if (desiredStatus && desiredStatus !== prevStatus) {
        const failureReason = desiredStatus === "failed" ? "error" : null;
        await this._updateBuildStatus(estateId, buildId, desiredStatus, failureReason);
        await this.ctx.storage.put(statusKey, desiredStatus);
        if (desiredStatus === "complete" || desiredStatus === "failed") {
          await this._removeHeartbeatAndReschedule(buildId);
        }
      }

      return new Response(JSON.stringify({ ok: true, lastSeq: newLast }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logger.error("estate-builds: handleIngest error:", error);
      return new Response("Internal error", { status: 500 });
    }
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const estateId = url.searchParams.get("estateId");
    const buildId = url.searchParams.get("buildId");

    if (!estateId || !buildId) {
      return new Response("Missing estateId or buildId", { status: 400 });
    }

    // Authorization is handled at the worker route via signed URLs / session checks

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Attach tags for easier retrieval and observability (runtime supports second param)
    (this.ctx as any).acceptWebSocket(server, [`estate:${estateId}`, `build:${buildId}`]);
    // Persist metadata across hibernations
    server.serializeAttachment({ estateId, buildId });

    const watchers = this.watchersByBuildId.get(buildId) || new Set<WebSocket>();
    watchers.add(server);
    this.watchersByBuildId.set(buildId, watchers);

    // On watcher connection, replay buffered logs from storage
    await this.replayLogsToWatcher(server, buildId);

    return new Response(null, { status: 101, webSocket: client });
  }

  // No message handling needed for watcher sockets

  async webSocketClose(ws: WebSocket) {
    const attachment = (ws as any).deserializeAttachment
      ? (ws as any).deserializeAttachment()
      : null;
    const buildId: string | undefined = attachment?.buildId ?? (ws as any).__buildId;
    if (!buildId) return;
    const watchers = this.watchersByBuildId.get(buildId);
    if (watchers) {
      watchers.delete(ws);
      if (watchers.size === 0) this.watchersByBuildId.delete(buildId);
    }
  }

  // Periodic alarm to detect stale builds
  async alarm() {
    const now = Date.now();
    const heartbeats = await this.ctx.storage.get<Record<string, number>>("heartbeats");
    if (!heartbeats) return;

    let changed = false;
    for (const [buildId, last] of Object.entries(heartbeats)) {
      if (now - last > 2 * 60_000) {
        // 2 minutes without heartbeat → timed out (distinct from explicit failure)
        await this.appendLog(buildId, now, "stdout", "[BUILD TIMED OUT]");
        this.broadcast({
          type: "LOG",
          buildId,
          stream: "stdout",
          message: "[BUILD TIMED OUT]",
          ts: now,
        });
        // Update DB and mark storage status
        const estateId = (await this.ctx.storage.get<string>(`estate_for_build:${buildId}`)) || "";
        if (estateId) {
          await this._markBuildTimedOut(estateId, buildId);
          await this.ctx.storage.put(`status:${buildId}`, "timed_out");
        }
        delete heartbeats[buildId];
        changed = true;
      }
    }
    if (changed) await this.ctx.storage.put("heartbeats", heartbeats);
    // Schedule the next alarm based on soonest timeout among active builds
    const values = Object.values(heartbeats);
    if (values.length > 0) {
      const earliestDue = Math.min(...values.map((last) => last + 2 * 60_000));
      await this.ctx.storage.setAlarm(new Date(earliestDue));
    }
  }

  private async handleGetLogs(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const buildId = url.searchParams.get("buildId");
    if (!buildId) return new Response("Missing buildId", { status: 400 });

    const rows = await this.ctx.storage.sql.exec<{ ts: string; stream: string; message: string }>(
      "SELECT ts, stream, message FROM logs WHERE build_id = ? ORDER BY ts ASC",
      buildId,
    );
    const logs = Array.from(rows, (r) => ({ ...r, ts: Number(r.ts) }));
    return new Response(JSON.stringify({ buildId, logs }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async ensureInitialized(): Promise<void> {
    const initialized = (await this.ctx.storage.get("__init__")) as boolean | undefined;
    if (!initialized) {
      // Single-step table + indexes (fresh schema)
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS logs (build_id TEXT, seq INTEGER, ts INTEGER, stream TEXT, message TEXT, event TEXT)",
      );
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_logs_build_ts ON logs (build_id, ts)",
      );
      this.ctx.storage.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_build_seq ON logs (build_id, seq)",
      );
      await this.ctx.storage.put("__init__", true);
    }
    // Purge logs older than 90 days on boot-up
    const retentionBefore = Date.now() - 90 * 24 * 60 * 60 * 1000;
    this.ctx.storage.sql.exec("DELETE FROM logs WHERE ts < ?", retentionBefore);
  }

  private async appendLog(
    buildId: string,
    ts: number,
    stream: "stdout" | "stderr",
    message: string,
    seqOverride?: number,
  ) {
    // Ensure seq is monotonic to satisfy unique index and preserve ordering
    let seq = seqOverride;
    if (typeof seq !== "number") {
      const rows = await this.ctx.storage.sql.exec(
        "SELECT MAX(seq) AS max_seq FROM logs WHERE build_id = ?",
        buildId,
      );
      const maxSeqVal = Array.isArray(rows) && rows.length > 0 ? (rows[0] as any)?.max_seq : null;
      const lastSeq = maxSeqVal !== null && maxSeqVal !== undefined ? Number(maxSeqVal) || 0 : 0;
      seq = lastSeq + 1;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO logs (build_id, seq, ts, stream, message) VALUES (?, ?, ?, ?, ?)",
      buildId,
      seq,
      ts,
      stream,
      message,
    );
  }

  private async touchHeartbeat(buildId: string) {
    const heartbeats = (await this.ctx.storage.get("heartbeats")) as
      | Record<string, number>
      | undefined;
    const updated = { ...(heartbeats || {}), [buildId]: Date.now() } as Record<string, number>;
    await this.ctx.storage.put("heartbeats", updated);
    // Schedule alarm for the earliest expected timeout among active builds
    const values = Object.values(updated);
    if (values.length > 0) {
      const earliestDue = Math.min(...values.map((last) => last + 2 * 60_000));
      await this.ctx.storage.setAlarm(new Date(earliestDue));
    }
  }

  private async _removeHeartbeatAndReschedule(buildId: string) {
    const heartbeats = (await this.ctx.storage.get("heartbeats")) as
      | Record<string, number>
      | undefined;
    if (!heartbeats) return;
    if (heartbeats[buildId] !== undefined) {
      delete heartbeats[buildId];
      await this.ctx.storage.put("heartbeats", heartbeats);
    }
    const values = Object.values(heartbeats);
    if (values.length > 0) {
      const earliestDue = Math.min(...values.map((last) => last + 2 * 60_000));
      await this.ctx.storage.setAlarm(new Date(earliestDue));
    }
  }

  private broadcast(message: BroadcastMessage) {
    const watchers = this.watchersByBuildId.get(message.buildId);
    if (!watchers || watchers.size === 0) return;
    const payload = JSON.stringify(message);
    for (const ws of watchers) {
      ws.send(payload);
    }
  }

  private async replayLogsToWatcher(ws: WebSocket, buildId: string) {
    const rows = await this.ctx.storage.sql.exec<{ ts: string; stream: string; message: string }>(
      "SELECT ts, stream, message FROM logs WHERE build_id = ? ORDER BY ts ASC LIMIT 5000",
      buildId,
    );
    for (const r of rows) {
      const msg: BroadcastMessage = {
        type: "LOG",
        buildId,
        stream: (r.stream as "stdout" | "stderr") || "stdout",
        message: String(r.message ?? ""),
        ts: Number(r.ts ?? Date.now()),
      };
      ws.send(JSON.stringify(msg));
    }
  }

  private async _updateBuildStatus(
    estateId: string,
    buildId: string,
    status: "in_progress" | "complete" | "failed",
    failureReason?: string | null,
  ): Promise<void> {
    const db = getDb();
    await db
      .update(schema.builds)
      .set({
        status,
        completedAt: status === "complete" || status === "failed" ? new Date() : null,
        failureReason: failureReason ?? null,
      })
      .where(sql`${schema.builds.id} = ${buildId}`);

    if (status === "complete" || status === "failed") {
      const estateWithOrg = await db.query.estate.findFirst({
        where: sql`${schema.estate.id} = ${estateId}`,
        with: { organization: true },
      });
      if (estateWithOrg?.organization) {
        await invalidateOrganizationQueries(this.env, estateWithOrg.organization.id, {
          type: "INVALIDATE",
          invalidateInfo: { type: "TRPC_QUERY", paths: ["estate.getBuilds"] },
        });
      }
    }
    // Broadcast status change to connected clients
    this.broadcast({ type: "STATUS", buildId, status, ts: Date.now() });
  }

  private async _markBuildTimedOut(estateId: string, buildId: string): Promise<void> {
    const db = getDb();
    await db
      .update(schema.builds)
      .set({
        status: "failed",
        completedAt: new Date(),
        failureReason: "timeout",
      })
      .where(sql`${schema.builds.id} = ${buildId}`);
    const estateWithOrg = await db.query.estate.findFirst({
      where: sql`${schema.estate.id} = ${estateId}`,
      with: { organization: true },
    });
    if (estateWithOrg?.organization) {
      await invalidateOrganizationQueries(this.env, estateWithOrg.organization.id, {
        type: "INVALIDATE",
        invalidateInfo: { type: "TRPC_QUERY", paths: ["estate.getBuilds"] },
      });
    }
    // Broadcast status change (failed due to timeout)
    this.broadcast({ type: "STATUS", buildId, status: "failed", ts: Date.now() });
  }

  private async _upsertIterateConfigFromLogs(estateId: string, buildId: string): Promise<void> {
    // Concatenate stdout logs and extract the last JSON object
    const rows = await this.ctx.storage.sql.exec(
      "SELECT message FROM logs WHERE build_id = ? AND stream = 'stdout' ORDER BY ts ASC",
      buildId,
    );
    let stdout = "";
    for (const r of rows) {
      stdout += String((r as any).message ?? "");
    }
    const match = stdout.match(/\{[\s\S]*\}(?![\s\S]*\{)/);
    if (!match) throw new Error("No iterate config JSON found in stdout");
    const config = JSON.parse(match[0]);
    const db = getDb();
    await db
      .insert(schema.iterateConfig)
      .values({ estateId, config })
      .onConflictDoUpdate({
        target: schema.iterateConfig.estateId,
        set: { config, updatedAt: new Date() },
      });
  }

  private async _upsertIterateConfigFromEvent(estateId: string, jsonString: string): Promise<void> {
    // Validate with zod, but accept any object shape
    const IterateConfigSchema = z.object({}).passthrough();
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(jsonString);
    } catch {
      return;
    }
    const parsed = IterateConfigSchema.safeParse(parsedJson);
    if (!parsed.success) return;
    const config = parsed.data;
    const db = getDb();
    await db
      .insert(schema.iterateConfig)
      .values({ estateId, config })
      .onConflictDoUpdate({
        target: schema.iterateConfig.estateId,
        set: { config, updatedAt: new Date() },
      });
  }
}
