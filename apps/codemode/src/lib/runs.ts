import { desc, eq } from "drizzle-orm";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { codemodeRunsTable } from "~/db/schema.ts";
import { summarizeCodeSnippet, summarizeResult } from "~/lib/run-preview.ts";

export const runsQueryKey = ["codemode-runs"] as const;

export const listRuns = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const rows = await context.db
    .select()
    .from(codemodeRunsTable)
    .orderBy(desc(codemodeRunsTable.id));

  return rows.map((row) => ({
    ...row,
    codePreview: summarizeCodeSnippet(row.codeSnippet),
    resultPreview: summarizeResult(row.result),
  }));
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

    return {
      run,
      breadcrumb: summarizeCodeSnippet(run.codeSnippet),
    };
  });
