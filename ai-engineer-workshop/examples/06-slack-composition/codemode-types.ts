export const codemodeBlockAddedType = "codemode-block-added" as const;
export const codemodeResultAddedType = "codemode-result-added" as const;

export function readCodemodeBlock(payload: unknown) {
  const blockId = Reflect.get(payload as object, "blockId");
  const code = Reflect.get(payload as object, "code");
  return typeof blockId === "string" && typeof code === "string" ? { blockId, code } : null;
}
