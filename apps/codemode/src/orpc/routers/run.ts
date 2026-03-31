import type { CodemodeRun } from "@iterate-com/codemode-contract";
import type { AppContext } from "~/context.ts";
import { codemodeRunsTable } from "~/db/schema.ts";
import { buildCodemodeContractContext } from "~/lib/codemode-contract-runtime.ts";
import { executeCodemodeFunction } from "~/lib/execute-code-v2.ts";
import { os } from "~/orpc/orpc.ts";

function createRunId() {
  return `${Date.now().toString()}-${crypto.randomUUID().slice(0, 8)}`;
}

async function saveRun(context: AppContext, run: CodemodeRun) {
  await context.db.insert(codemodeRunsTable).values({
    id: run.id,
    runnerKind: run.runnerKind,
    codeSnippet: run.code,
    result: run.result,
    logsJson: JSON.stringify(run.logs),
    error: run.error,
  });
}

export const runRouter = {
  runV2: os.runV2.handler(async ({ context, input }) => {
    const execution = await executeCodemodeFunction({
      code: input.code,
      loader: context.loader,
      config: context.config,
    });
    const run: CodemodeRun = {
      id: createRunId(),
      runnerKind: "deterministic-v2",
      code: input.code,
      result: execution.result,
      logs: execution.logs,
      error: execution.error,
    };

    await saveRun(context, run);

    return run;
  }),
  ctxTypeDefinition: os.ctxTypeDefinition.handler(
    async ({ context }) => buildCodemodeContractContext(context.config).ctxTypes,
  ),
};
