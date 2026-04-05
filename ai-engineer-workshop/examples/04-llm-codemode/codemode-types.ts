import { z } from "zod";

export const codemodeBlockAddedType = "codemode-block-added" as const;
export const codemodeResultAddedType = "codemode-result-added" as const;

export const CodemodeBlockAddedPayload = z.object({
  requestId: z.string().min(1),
  blockId: z.string().min(1),
  language: z.literal("ts"),
  code: z.string().min(1),
});

export const CodemodeResultAddedPayload = z.object({
  requestId: z.string().min(1),
  blockId: z.string().min(1),
  blockCount: z.number().int().positive(),
  success: z.boolean(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  codePath: z.string().min(1),
  outputPath: z.string().min(1),
});

export function extractTypeScriptBlocks(outputText: string) {
  return [...outputText.matchAll(/```ts\s*([\s\S]*?)```/g)]
    .map((match, index) => ({
      blockId: `ts-block-${index + 1}`,
      code: match[1]?.trim() ?? "",
    }))
    .filter((block) => block.code.length > 0);
}
