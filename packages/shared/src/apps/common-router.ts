import { implement, ORPCError } from "@orpc/server";
import { z, type ZodTypeAny } from "zod";
import { getPublicConfig } from "./config.ts";
import { commonContract } from "./common-router-contract.ts";
import type { AppContext } from "./types.ts";

export function createCommonRouter<TConfigSchema extends ZodTypeAny>(options: {
  appConfigSchema: TConfigSchema;
}) {
  const os = implement(commonContract).$context<AppContext<any, z.output<TConfigSchema>>>();

  return os.router({
    health: os.health.handler(({ context }) => ({
      ok: true as const,
      app: context.manifest.slug,
      version: context.manifest.version,
    })),
    publicConfig: os.publicConfig.handler(({ context }) =>
      getPublicConfig(context.config, options.appConfigSchema),
    ),
    debug: os.debug.handler(() => createCommonDebugOutput()),
    execSql: os.execSql.handler(async ({ context, input }) => {
      const result = await tryExecuteCommonSql(context, input.statement);
      if (result) {
        return result;
      }

      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "common.execSql is not available for this app",
      });
    }),
    refreshRegistry: os.refreshRegistry.handler(() => {
      throw new ORPCError("NOT_IMPLEMENTED", {
        message: "common.refreshRegistry is not implemented for this app yet",
      });
    }),
  });
}

export function createCommonDebugOutput() {
  if (typeof process === "undefined") {
    return { runtime: "workerd" };
  }

  return {
    runtime: "node",
    pid: process.pid,
    ppid: process.ppid,
    uptimeSec: process.uptime(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    execPath: process.execPath,
    argv: process.argv,
    env: Object.fromEntries(
      Object.entries(process.env).map(([key, value]) => [key, value ?? null] as const),
    ),
    memoryUsage: process.memoryUsage(),
  };
}

export async function tryExecuteCommonSql(context: object, statement: string) {
  const db = Reflect.get(context, "db");
  const client = typeof db === "object" && db !== null ? (Reflect.get(db, "$client") ?? db) : null;

  if (!client || typeof Reflect.get(client, "prepare") !== "function") {
    return null;
  }

  const prepared = Reflect.get(client, "prepare").call(client, statement);
  if (typeof prepared !== "object" || prepared === null) {
    return null;
  }

  if (
    Reflect.get(prepared, "reader") === true &&
    typeof Reflect.get(prepared, "columns") === "function" &&
    typeof Reflect.get(prepared, "raw") === "function"
  ) {
    const columns = prepared.columns().map((column: { name: string }) => column.name);
    const rows = prepared
      .raw()
      .all()
      .map((row: unknown[]) =>
        Object.fromEntries(
          columns.map((column: string, index: number) => [column, normalizeSqlValue(row[index])]),
        ),
      );

    return {
      rows,
      columns,
      stat: {
        rowsAffected: rows.length,
        rowsRead: null,
        rowsWritten: null,
        queryDurationMs: null,
      },
    };
  }

  if (isReadOnlySql(statement) && typeof Reflect.get(prepared, "all") === "function") {
    const result = await Reflect.get(prepared, "all").call(prepared);
    const rows = Array.isArray(result?.results) ? result.results : [];

    return {
      rows,
      columns: Object.keys(rows[0] ?? {}),
      stat: {
        rowsAffected: rows.length,
        rowsRead: result?.meta?.rows_read ?? null,
        rowsWritten: result?.meta?.rows_written ?? null,
        queryDurationMs: result?.meta?.timings?.sql_duration_ms ?? result?.meta?.duration ?? null,
      },
    };
  }

  if (typeof Reflect.get(prepared, "run") !== "function") {
    return null;
  }

  const result = await Reflect.get(prepared, "run").call(prepared);

  return {
    rows: [],
    columns: [],
    stat: {
      rowsAffected: result?.changes ?? result?.meta?.changes ?? 0,
      rowsRead: result?.meta?.rows_read ?? null,
      rowsWritten: result?.meta?.rows_written ?? null,
      queryDurationMs: result?.meta?.timings?.sql_duration_ms ?? result?.meta?.duration ?? null,
    },
    lastInsertRowid:
      result?.lastInsertRowid ?? result?.meta?.last_row_id ?? result?.meta?.lastInsertRowid,
  };
}

function normalizeSqlValue(value: unknown) {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }

  return value;
}

function isReadOnlySql(statement: string) {
  return /^(select|with|pragma|explain)\b/i.test(statement.trim());
}
