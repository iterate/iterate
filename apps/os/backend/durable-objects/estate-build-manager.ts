import { Container } from "@cloudflare/containers";
import { ms } from "itty-time";
import { typeid } from "typeid-js";
import { and, eq, lt } from "drizzle-orm";
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
  event: "info" | "stdout" | "output" | "error" | "complete";
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
            log_lines TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
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
    this._sql.exec(
      `INSERT INTO builds (id, status, repo_meta) VALUES (?, ?, ?)`,
      buildId,
      "in_progress",
      JSON.stringify({ repo, branch, path, authToken }),
    );
    const logId = typeid("build_log").toString();
    this._sql.exec(
      `INSERT INTO build_logs (id, build_id, log_lines) VALUES (?, ?, ?)`,
      logId,
      buildId,
      JSON.stringify([]),
    );

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
    waitUntil(this.syncLogsForAllOngoingBuilds());

    if (this.ctx.container?.running && !this.stopRequested) {
      const logsRes = await Promise.race([
        this.containerFetch(
          new Request(`http://localhost:3000/logs?buildId=${buildId}&type=sse`),
          3000,
        ).catch(() => ({ ok: false }) as const),
        new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 5000)),
      ]);

      if (!logsRes.ok) {
        // If the current container doesn't have the logs, they might be old logs, try to fetch them from the database
        const logLines = this.getLogsFromDatabase(buildId);
        return intoImmediateSSEResponse(logLines);
      }

      return logsRes;
    } else {
      // If the container is not running, fetch the logs from the database
      const logLines = this.getLogsFromDatabase(buildId);
      return intoImmediateSSEResponse(logLines);
    }
  }

  async onActivityExpired() {
    await this.syncLogsForAllOngoingBuilds();
    await this.handleTerminatingLogs();

    const buildsInProgress = this._sql
      .exec<{ id: string }>("SELECT id FROM builds WHERE status = 'in_progress'")
      .toArray();

    if (buildsInProgress.length === 0) {
      // stop the container if there are no in-progress builds
      this.stop();
      this.stopRequested = true;
    }
  }

  private getLogsFromDatabase(buildId: string) {
    try {
      const log = this._sql
        .exec("SELECT log_lines FROM build_logs WHERE build_id = ?", buildId)
        .one();
      const logLines = log?.log_lines;
      if (typeof logLines !== "string") return [];
      return JSON.parse(logLines) as Array<Log>;
    } catch {
      return [];
    }
  }

  private async getBuilderMetadata() {
    const metadata = this.ctx.storage.kv.get<{ orgId: string; estateId: string }>(
      "builder-metadata",
    );
    if (metadata) return metadata;
    const sampleBuild = this._sql.exec<{ id: string }>("SELECT id FROM builds").one();
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
    const ongoingBuilds = this._sql
      .exec<{ id: string }>("SELECT id FROM builds WHERE status = 'in_progress'")
      .toArray();

    if (ongoingBuilds.length === 0) return;

    const logsResponse = await Promise.all(
      ongoingBuilds.map(async (build) => {
        const logRes = await this.containerFetch(
          new Request(`http://localhost:3000/logs?buildId=${build.id}`),
          3000,
        );
        if (!logRes.ok) return { buildId: build.id, logs: [] };
        const logs = await logRes
          .json<{ logs: Array<Log> }>()
          .catch(() => ({ logs: <Array<Log>>[] }));
        return { buildId: build.id, logs: logs.logs };
      }),
    );

    for (const { buildId, logs } of logsResponse) {
      this._sql.exec(
        "UPDATE build_logs SET log_lines = ?, updated_at = CURRENT_TIMESTAMP WHERE build_id = ?",
        JSON.stringify(logs),
        buildId,
      );
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

    await Promise.all(
      allLogs.map(async ({ buildId, logs }) => {
        const terminatingLog = logs.find(
          (log) => log.event === "complete" || log.event === "error",
        );
        const outputLog = logs.find((log) => log.event === "output");
        if (terminatingLog) {
          const status = terminatingLog.event === "complete" ? "complete" : "failed";
          this._sql.exec(
            "UPDATE builds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            status,
            buildId,
          );
          await this.db
            .update(schemas.builds)
            .set({ status })
            .where(eq(schemas.builds.id, buildId));

          // Update the iterate config in the database if this is the newest triggered build
          if (outputLog && buildId === newestTriggeredBuild.buildId) {
            const config = JSON.parse(outputLog.data);
            await this.db
              .insert(schemas.iterateConfig)
              .values({ estateId, config })
              .onConflictDoUpdate({
                target: [schemas.iterateConfig.estateId],
                set: { config },
              });
          }
        }
      }),
    );

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
      if (!res.ok) continue;

      const { promise, resolve } = Promise.withResolvers<void>();

      (async () => {
        const reader = res.body?.getReader();
        if (!reader) return;
        // wait till sse stream is closed
        while (true) {
          const { done } = await reader.read();
          if (done) {
            resolve();
            break;
          }
        }
      })();

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

    // Timeout in-progress builds that have been running for too long
    this._sql.exec(
      "UPDATE builds SET status = 'failed' WHERE status = 'in_progress' AND updated_at < ?",
      timeoutThreshold,
    );

    await this.db
      .update(schemas.builds)
      .set({ status: "failed", failureReason: "Build timed out" })
      .where(
        and(
          eq(schemas.builds.status, "in_progress"),
          lt(schemas.builds.updatedAt, new Date(Date.now() - TIMEOUT_TIME)),
        ),
      );
  }
}
