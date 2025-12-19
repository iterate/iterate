import { Container } from "@cloudflare/containers";
import { ms } from "itty-time";
import { typeid } from "typeid-js";
import { and, eq, lt, or } from "drizzle-orm";
import { waitUntil, type CloudflareEnv } from "../../env.ts";
import { intoImmediateSSEResponse } from "../utils/sse-utils.ts";
import { getDb } from "../db/client.ts";
import * as schemas from "../db/schema.ts";
import { invalidateOrganizationQueries } from "../utils/websocket-utils.ts";

const RETENTION_TIME = ms("30 days");
const TIMEOUT_TIME = ms("10 minutes");

type BuildInput = {
  buildId: string;
  repo: string;
  branch: string;
  path: string;
  authToken?: string;
};

export type Log = {
  event: "info" | "stdout" | "files" | "output" | "error" | "complete";
  data: string;
};

export class EstateBuildManager extends Container {
  declare env: CloudflareEnv;

  defaultPort = 3000;
  sleepAfter = "1m";

  private _sql = this.ctx.storage.sql;
  private stopRequested = false;
  private db = getDb();
  private buildWaiters = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState<{}>, env: CloudflareEnv) {
    super(ctx, env);

    const tableInfo = this._sql
      .exec<{ name: string; type: string }>("pragma table_info(build_logs)")
      .toArray();

    if (tableInfo.some((col) => col.name === "log_lines")) {
      this._sql.exec(`drop table build_logs`);
    }

    this._sql.exec(`
        CREATE TABLE IF NOT EXISTS builds (
            id TEXT PRIMARY KEY NOT NULL,
            status TEXT NOT NULL,
            repo_meta TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS build_logs (
            id TEXT PRIMARY KEY NOT NULL,
            build_id TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS build_log_lines (
            build_id TEXT NOT NULL,
            data TEXT NOT NULL,
            idx INTEGER NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS build_log_lines_build_idx ON build_log_lines (build_id, idx);
    `);

    waitUntil(
      (async () => {
        // Sync logs for all ongoing builds
        await this.syncLogsForAllOngoingBuilds();
        // Act on the synced logs to update the build status and iterate config
        await this.handleTerminatingLogs();
        // Attach build waiters to the ongoing builds to wait for the builds to complete
        await this.attachBuildWaiters();
        // Run housekeeping to delete old build logs
        await this.housekeeping();
      })(),
    );
  }

  public async build({ buildId, repo, branch, path, authToken }: BuildInput) {
    const buildExists =
      this._sql.exec<{ id: string }>("SELECT id FROM builds WHERE id = ?", buildId).toArray()
        .length > 0;

    if (!buildExists) {
      this._sql.exec(
        `INSERT INTO builds (id, status, repo_meta) VALUES (?, ?, ?)`,
        buildId,
        "in_progress",
        JSON.stringify({ repo, branch, path, authToken }),
      );
      const logId = typeid("build_log").toString();
      this._sql.exec(`INSERT INTO build_logs (id, build_id) VALUES (?, ?)`, logId, buildId);
    }

    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
      },
      ports: [3000],
    });

    const request = new Request(`http://localhost:3000/trigger-build`, {
      method: "POST",
      body: JSON.stringify({
        buildId,
        repo,
        branch,
        path,
        authToken,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const response = await this.containerFetch(request, 3000);
    if (!response.ok || !response.body)
      throw new Error(`Failed to run config: ${response.statusText} ${await response.text()}`);
    const res = await response.text();

    // Attach build waiters to the ongoing builds to wait for the builds to complete
    waitUntil(this.attachBuildWaiters());

    return {
      success: true,
      message: res,
      buildId,
    };
  }

  public async getSSELogStream(buildId: string) {
    // Check if build is completed - if so, serve from database directly
    const build = this._sql
      .exec<{ status: string }>("SELECT status FROM builds WHERE id = ?", buildId)
      .toArray()[0];

    if (build && build.status !== "in_progress") {
      const logLines = this.getLogsFromDatabase(buildId);
      if (logLines.length > 0) {
        return intoImmediateSSEResponse(logLines);
      }
      // Build completed but no logs - try to sync from container if running
    }

    // Build is in progress or completed without logs - try streaming from container
    if (this.ctx.container?.running && !this.stopRequested) {
      const logsRes = await Promise.race([
        this.containerFetch(
          new Request(`http://localhost:3000/logs?buildId=${buildId}&type=sse`),
          3000,
        ).catch(() => ({ ok: false }) as const),
        new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 5000)),
      ]);

      if (!logsRes.ok) {
        // SSE endpoint failed - try to sync from JSON endpoint
        await this.syncLogsForBuild(buildId);
        const logLines = this.getLogsFromDatabase(buildId);
        return intoImmediateSSEResponse(logLines);
      }

      return logsRes;
    }

    // Container not running - serve whatever we have from database
    const logLines = this.getLogsFromDatabase(buildId);
    return intoImmediateSSEResponse(logLines);
  }

  private async syncLogsForBuild(buildId: string) {
    if (!this.ctx.container?.running) return;

    try {
      const logRes = await this.containerFetch(
        new Request(`http://localhost:3000/logs?buildId=${buildId}`),
        3000,
      );
      if (!logRes.ok) return;

      const logs = await logRes
        .json<{ logs: Array<Log> }>()
        .catch(() => ({ logs: <Array<Log>>[] }));

      this.persistLogsToDatabase(buildId, logs.logs);
    } catch {
      // Ignore errors - we'll fall back to whatever is in the database
    }
  }

  private persistLogsToDatabase(buildId: string, logs: Log[]) {
    // Don't persist empty logs - this would delete existing logs
    if (logs.length === 0) return;

    for (const [index, log] of logs.entries()) {
      this._sql.exec(
        `INSERT OR REPLACE INTO build_log_lines (build_id, data, idx, created_at, updated_at) 
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        buildId,
        JSON.stringify(log),
        index,
      );
    }
    this._sql.exec(
      `DELETE FROM build_log_lines WHERE build_id = ? AND idx >= ?`,
      buildId,
      logs.length,
    );
  }

  async onActivityExpired() {
    await this.syncLogsForAllOngoingBuilds();
    await this.handleTerminatingLogs();
    await this.housekeeping();

    const buildsInProgress = this._sql
      .exec<{ id: string }>("SELECT id FROM builds WHERE status = 'in_progress'")
      .toArray();

    if (buildsInProgress.length === 0) {
      this.stopRequested = true;
      this.stop();
    }
  }

  private getLogsFromDatabase(buildId: string) {
    try {
      const lines = this._sql
        .exec("select data, idx from build_log_lines where build_id = ?", buildId)
        .toArray()
        .sort((a, b) => Number(a.idx) - Number(b.idx)); // for some reason order by in the sql statement makes the whole thing fail
      return lines
        .map((line) => JSON.parse(line.data as string) as Log)
        .filter(
          (log) => log.data.trim() !== "" || log.event === "complete" || log.event === "error",
        );
    } catch {
      return [];
    }
  }

  private async getBuilderMetadata() {
    const metadata = this.ctx.storage.kv.get<{ orgId: string; estateId: string }>(
      "builder-metadata",
    );
    if (metadata) return metadata;
    const sampleBuild = this._sql
      .exec<{ id: string }>("SELECT id FROM builds LIMIT 1")
      .toArray()[0];
    if (!sampleBuild) throw new Error(`Attempted get metadata for builder, but no builds found`);
    const { estateId, orgId } = await this.db.query.builds
      .findFirst({
        where: eq(schemas.builds.id, sampleBuild.id),
        columns: { estateId: true },
        with: {
          estate: {
            columns: { organizationId: true },
          },
        },
      })
      .then((res) => ({ orgId: res?.estate.organizationId, estateId: res?.estateId }));
    if (!orgId || !estateId)
      throw new Error(`Failed to find organization or estate for build ${sampleBuild.id}`);
    this.ctx.storage.kv.put("builder-metadata", { orgId, estateId });
    return { orgId, estateId };
  }

  private async syncLogsForAllOngoingBuilds() {
    if (!this.ctx.container?.running) return;

    // Sync in_progress builds AND any builds that have no logs yet (may have completed before sync)
    const buildsToSync = this._sql
      .exec<{ id: string }>(
        `SELECT DISTINCT b.id FROM builds b 
         LEFT JOIN build_log_lines l ON b.id = l.build_id 
         WHERE b.status = 'in_progress' OR l.build_id IS NULL`,
      )
      .toArray();

    if (buildsToSync.length === 0) return;

    const logsResponse = await Promise.all(
      buildsToSync.map(async (build) => {
        const logRes = await this.containerFetch(
          new Request(`http://localhost:3000/logs?buildId=${build.id}`),
          3000,
        );
        if (!logRes.ok) return { buildId: build.id, logs: [] as Log[] };
        const logs = await logRes.json<{ logs: Log[] }>().catch(() => ({ logs: [] as Log[] }));
        return { buildId: build.id, logs: logs.logs };
      }),
    );

    for (const { buildId, logs } of logsResponse) {
      this.persistLogsToDatabase(buildId, logs);
    }
  }

  private async handleTerminatingLogs() {
    if (!this.ctx.container?.running) return;

    const ongoingBuilds = this._sql
      .exec<{
        id: string;
        updated_at: string;
      }>("SELECT id, updated_at FROM builds WHERE status = 'in_progress'")
      .toArray();

    if (ongoingBuilds.length === 0) return;

    const { estateId, orgId } = await this.getBuilderMetadata();

    const allLogs = ongoingBuilds.map((build) => ({
      buildId: build.id,
      // SQLite CURRENT_TIMESTAMP is stored as a sortable text value ("YYYY-MM-DD HH:MM:SS"),
      // so we can safely use lexicographical comparison to find the newest build.
      updatedAt: build.updated_at,
      logs: this.getLogsFromDatabase(build.id),
    }));
    const newestTriggeredBuild = allLogs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0]!;

    const results = await Promise.allSettled(
      allLogs.map(async ({ buildId, logs }) => {
        const terminatingLog = logs.find(
          (log) => log.event === "complete" || log.event === "error",
        );
        const outputLog = logs.find((log) => log.event === "output");
        const filesLog = logs.find((log) => log.event === "files");
        if (terminatingLog) {
          const status = terminatingLog.event === "complete" ? "complete" : "failed";
          this._sql.exec(
            "UPDATE builds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            status,
            buildId,
          );

          const buildUpdate: Partial<typeof schemas.builds.$inferSelect> = { status };

          if (filesLog) {
            const files = JSON.parse(filesLog.data);
            buildUpdate.files = files;
          }
          if (outputLog) {
            const config = JSON.parse(outputLog.data);
            buildUpdate.config = config;
          }

          await this.db
            .update(schemas.builds)
            .set(buildUpdate)
            .where(eq(schemas.builds.id, buildId));

          // Update the iterate config in the database if this is the newest triggered build
          if (buildId === newestTriggeredBuild.buildId && status === "complete") {
            await this.db
              .insert(schemas.iterateConfig)
              .values({ estateId, buildId })
              .onConflictDoUpdate({
                target: [schemas.iterateConfig.estateId],
                set: { buildId },
              });
          }
        }
      }),
    );

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, `Failed to update ${errors.length} build statuses`);

    await invalidateOrganizationQueries(this.env, orgId, {
      type: "INVALIDATE",
      invalidateInfo: {
        type: "TRPC_QUERY",
        paths: ["estate.getBuilds"],
      },
    });
  }

  private async attachBuildWaiters() {
    if (!this.ctx.container?.running) return;
    const buildsInProgress = this._sql
      .exec<{ id: string }>("SELECT id FROM builds WHERE status = 'in_progress'")
      .toArray();

    if (buildsInProgress.length === 0) return;

    for (const build of buildsInProgress) {
      if (this.buildWaiters.has(build.id)) continue;
      const res = await this.containerFetch(
        new Request(`http://localhost:3000/wait-for-build?buildId=${build.id}`),
        3000,
      );
      if (!res.ok) {
        // Build might have already completed - sync its logs before continuing
        await this.syncLogsForBuild(build.id);
        await this.handleTerminatingLogs();
        continue;
      }

      const { promise, resolve } = Promise.withResolvers<void>();

      // for error reporting, wrapping in waitUntil
      waitUntil(
        (async () => {
          const reader = res.body?.getReader();
          if (!reader) {
            resolve();
            return;
          }
          const timeoutPromise = new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), TIMEOUT_TIME),
          );
          while (true) {
            const { done } = await Promise.race([reader.read(), timeoutPromise]);
            if (done) {
              resolve();
              break;
            }
          }
        })(),
      );

      this.buildWaiters.set(build.id, promise);
      promise.finally(async () => {
        this.buildWaiters.delete(build.id);
        await this.syncLogsForAllOngoingBuilds();
        await this.handleTerminatingLogs();
      });
    }
  }

  private async housekeeping() {
    const retentionThreshold = new Date(Date.now() - RETENTION_TIME)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const timeoutThreshold = new Date(Date.now() - TIMEOUT_TIME)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");

    // Delete old build logs
    this._sql.exec(`DELETE FROM build_logs WHERE created_at < ?`, retentionThreshold);
    this._sql.exec(`DELETE FROM build_log_lines WHERE created_at < ?`, retentionThreshold);

    // Timeout in-progress builds that have been running for too long
    this._sql.exec(
      "UPDATE builds SET status = 'failed' WHERE status = 'in_progress' AND updated_at < ?",
      timeoutThreshold,
    );

    const { estateId } = await this.getBuilderMetadata().catch(() => ({ estateId: null }));

    if (estateId) {
      await this.db
        .update(schemas.builds)
        .set({ status: "failed", failureReason: "Build timed out" })
        .where(
          and(
            eq(schemas.builds.estateId, estateId),
            or(eq(schemas.builds.status, "in_progress"), eq(schemas.builds.status, "queued")),
            lt(schemas.builds.updatedAt, new Date(Date.now() - TIMEOUT_TIME)),
          ),
        );
    }
  }
}
