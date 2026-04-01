import { desc, eq, sql } from "drizzle-orm";
import type { CodemodeRun } from "@iterate-com/codemode-contract";
import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import { codemodeRunsTable } from "~/db/schema.ts";
import { buildCodemodeContextFromSources } from "~/lib/codemode-contract-runtime.ts";
import { executeCodemodeFunction } from "~/lib/execute-code-v2.ts";
import { parseCodemodeRunRecord, summarizeCodemodeRun } from "~/lib/runs.ts";
import { os } from "~/orpc/orpc.ts";

function createRunId() {
  return `${Date.now().toString()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function saveRun(context: AppContext, run: CodemodeRun, logs: string[]) {
  await context.db.insert(codemodeRunsTable).values({
    id: run.id,
    runnerKind: run.runnerKind,
    codeSnippet: run.code,
    sourcesJson: JSON.stringify(run.sources),
    result: run.result,
    logsJson: JSON.stringify(logs),
    error: run.error,
  });
}

function toCodemodeRequestError(error: unknown) {
  if (error instanceof ORPCError) {
    return error;
  }

  if (error instanceof Error) {
    return new ORPCError("BAD_REQUEST", {
      message: error.message,
    });
  }

  return new ORPCError("INTERNAL_SERVER_ERROR", {
    message: "Internal server error",
  });
}

export const runRouter = {
  runV2: os.runV2.handler(async ({ context, input }) => {
    try {
      const execution = await executeCodemodeFunction({
        code: input.code,
        loader: context.env.LOADER,
        outbound: context.env.OUTBOUND,
        config: context.config,
        sources: input.sources,
      });
      const run: CodemodeRun = {
        id: createRunId(),
        runnerKind: "deterministic-v2",
        code: input.code,
        sources: input.sources,
        result: execution.result,
        error: execution.error,
      };

      await saveRun(context, run, execution.logs);

      return run;
    } catch (error) {
      throw toCodemodeRequestError(error);
    }
  }),
  runs: os.runs.router({
    list: os.runs.list.handler(async ({ context, input }) => {
      const rows = await context.db
        .select()
        .from(codemodeRunsTable)
        .orderBy(desc(codemodeRunsTable.id))
        .limit(input.limit)
        .offset(input.offset);

      const [{ count }] = await context.db
        .select({ count: sql<number>`count(*)` })
        .from(codemodeRunsTable);

      return {
        runs: rows.map((row) => summarizeCodemodeRun(parseCodemodeRunRecord(row))),
        total: Number(count ?? 0),
      };
    }),
    find: os.runs.find.handler(async ({ context, input }) => {
      const [run] = await context.db
        .select()
        .from(codemodeRunsTable)
        .where(eq(codemodeRunsTable.id, input.id))
        .limit(1);

      if (!run) {
        throw new ORPCError("NOT_FOUND", {
          message: `Run ${input.id} not found`,
        });
      }

      return parseCodemodeRunRecord(run);
    }),
  }),
  ctxTypeDefinition: os.ctxTypeDefinition.handler(async ({ context, input }) => {
    try {
      const runtimeContext = await buildCodemodeContextFromSources({
        config: context.config,
        sources: input.sources,
        fetch: (input, init) =>
          context.env.OUTBOUND.fetch(
            input instanceof Request ? new Request(input, init) : new Request(input, init),
          ),
      });

      return runtimeContext.ctxTypes;
    } catch (error) {
      throw toCodemodeRequestError(error);
    }
  }),
};
