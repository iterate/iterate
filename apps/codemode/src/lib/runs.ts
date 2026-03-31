import { desc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CodemodeRunnerKind } from "@iterate-com/codemode-contract";
import { codemodeRunsTable } from "~/db/schema.ts";
import { summarizeCodeSnippet, summarizeError, summarizeResult } from "~/lib/run-preview.ts";

const StoredRun = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  codeSnippet: z.string(),
  result: z.string(),
  logsJson: z.string(),
  error: z.string().nullable(),
});

function parseRun(row: unknown) {
  const parsed = StoredRun.parse(row);

  return {
    ...parsed,
    logs: z.array(z.string()).parse(JSON.parse(parsed.logsJson)),
  };
}

export const runsQueryKey = ["codemode-runs"] as const;

export const listRuns = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(codemodeRunsTable)
    .orderBy(desc(codemodeRunsTable.id));

  return rows.map((row) => {
    const run = parseRun(row);

    return {
      ...run,
      codePreview: summarizeCodeSnippet(run.codeSnippet),
      resultPreview: summarizeError(run.error) ?? summarizeResult(run.result),
    };
  });
});

export const getRun = createServerFn({ method: "GET" })
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ context, data }) => {
    const [run] = await context.db
      .select()
      .from(codemodeRunsTable)
      .where(eq(codemodeRunsTable.id, data.id))
      .limit(1);

    if (!run) {
      throw new Error(`Run ${data.id} not found`);
    }

    const parsedRun = parseRun(run);

    return {
      run: parsedRun,
      breadcrumb: summarizeCodeSnippet(parsedRun.codeSnippet),
    };
  });
