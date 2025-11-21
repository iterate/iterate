import { Container } from "@cloudflare/containers";
import { ms } from "itty-time";
import { typeid } from "typeid-js";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { waitUntil } from "../../env.ts";
import type { CloudflareEnv } from "../../env.ts";

const RETENTION_TIME = ms("30 days");

type BuildInput = {
  repo: string;
  branch: string;
  path: string;
  authToken: string;
};

export class EstateBuildManager extends Container<CloudflareEnv> {
  defaultPort = 3000;
  sleepAfter = "1m";

  private _sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState<{}>, env: CloudflareEnv) {
    super(ctx, env);
    this._sql.exec(`
        CREATE TABLE IF NOT EXISTS builds (
            id TEXT PRIMARY KEY NOT NULL,
            status TEXT NOT NULL,
            repo_meta TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        );

        CREATE TABLE IF NOT EXISTS build_logs (
            id TEXT PRIMARY KEY NOT NULL,
            build_id TEXT NOT NULL,
            log_lines JSONB NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        );
    `);

    const retentionBefore = Date.now() - RETENTION_TIME;
    this._sql.exec(`DELETE FROM build_logs WHERE created_at < ?`, retentionBefore);
  }

  async build({ repo, branch, path, authToken }: BuildInput) {
    const buildId = typeid("build").toString();
    this._sql.exec(
      `INSERT INTO builds (id, status, repo_meta) VALUES (?, ?, ?)`,
      buildId,
      "in_progress",
      { repo, branch, path, authToken },
    );
    const logId = typeid("build_log").toString();
    this._sql.exec(
      `INSERT INTO build_logs (id, build_id, log_lines) VALUES (?, ?, ?)`,
      logId,
      buildId,
      [],
    );

    await this.startAndWaitForPorts({
      startOptions: {
        enableInternet: true,
      },
      ports: [3000],
    });

    const request = new Request(`http://localhost:3000/run-config`, {
      method: "POST",
      body: JSON.stringify({ repo, branch, path, authToken }),
    });

    const response = await this.containerFetch(request, 3000);
    if (!response.ok || !response.body)
      throw new Error(`Failed to run config: ${response.statusText} ${await response.text()}`);

    const [b1, b2] = response.body.tee();

    const eventStream = b2
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    const aggregator = async () => {
      const reader = eventStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        this._sql.exec(
          `UPDATE build_logs
                 SET log_lines = json_array_append(log_lines, '$', ?)
                 WHERE id = ?;`,
          value,
          logId,
        );
      }
    };

    waitUntil(aggregator());
    return new Response(b1, { headers: response.headers, status: response.status });
  }
}
