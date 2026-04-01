import { z } from "zod";
import {
  CodemodeRunRecord,
  CodemodeRunSummary,
  CodemodeRunnerKind,
  CodemodeSource,
} from "@iterate-com/codemode-contract";
import { summarizeCodeSnippet, summarizeError, summarizeResult } from "~/lib/run-preview.ts";

const StoredRun = z.object({
  id: z.string(),
  runnerKind: CodemodeRunnerKind,
  codeSnippet: z.string(),
  sourcesJson: z.string(),
  result: z.string(),
  logsJson: z.string(),
  error: z.string().nullable(),
});

export const LIST_RUNS_INPUT = {
  limit: 30,
  offset: 0,
} as const;

export function parseCodemodeRunRecord(row: unknown) {
  const parsed = StoredRun.parse(row);

  return CodemodeRunRecord.parse({
    id: parsed.id,
    runnerKind: parsed.runnerKind,
    codeSnippet: parsed.codeSnippet,
    sources: CodemodeSource.array().parse(JSON.parse(parsed.sourcesJson)),
    result: parsed.result,
    logs: z.array(z.string()).parse(JSON.parse(parsed.logsJson)),
    error: parsed.error,
  });
}

export function summarizeCodemodeRun(run: z.infer<typeof CodemodeRunRecord>) {
  const outputParts = [...run.logs];

  if (run.result.trim().length > 0) {
    outputParts.push(run.result);
  }

  return CodemodeRunSummary.parse({
    id: run.id,
    codePreview: summarizeCodeSnippet(run.codeSnippet),
    resultPreview: summarizeError(run.error) ?? summarizeResult(outputParts.join("\n")),
  });
}
