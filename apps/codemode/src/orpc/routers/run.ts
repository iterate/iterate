import { codemodeRunsTable } from "~/db/schema.ts";
import { executeCodeInDynamicWorker } from "~/lib/execute-code.ts";
import { os } from "~/orpc/orpc.ts";

export const runRouter = {
  run: os.run.handler(async ({ context, input }) => {
    const result = await executeCodeInDynamicWorker({
      code: input.code,
      loader: context.loader,
    });
    const id = `${Date.now().toString()}-${crypto.randomUUID().slice(0, 8)}`;

    await context.db.insert(codemodeRunsTable).values({
      id,
      codeSnippet: input.code,
      result,
    });

    return {
      id,
      code: input.code,
      result,
    };
  }),
};
