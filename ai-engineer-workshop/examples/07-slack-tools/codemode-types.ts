export type ExecutionCtx = { streamPath: string; [key: string]: unknown };

export const codemodeBlockAddedType = "codemode-block-added" as const;
export const codemodeToolAddedType = "codemode-tool-added" as const;
export const codemodeResultAddedType = "codemode-result-added" as const;

export function readCodemodeBlock(payload: unknown) {
  const blockId = Reflect.get(payload as object, "blockId");
  const code = Reflect.get(payload as object, "code");
  return typeof blockId === "string" && typeof code === "string" ? { blockId, code } : null;
}

export function readCodemodeTool(payload: unknown) {
  const toolName = Reflect.get(payload as object, "toolName");
  const code = Reflect.get(payload as object, "code");
  const description = Reflect.get(payload as object, "description");
  return typeof toolName === "string" && typeof code === "string"
    ? { toolName, code, description: typeof description === "string" ? description : null }
    : null;
}
