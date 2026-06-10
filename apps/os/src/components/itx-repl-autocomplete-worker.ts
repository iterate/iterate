import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { VirtualTypeScriptEnvironment } from "@typescript/vfs";
import { getAutocompletion } from "@valtown/codemirror-ts/worker";
import ts from "typescript";

export async function getAutocompletionWithDocs(input: {
  context: Pick<CompletionContext, "explicit" | "pos">;
  env: VirtualTypeScriptEnvironment;
  path: string;
}): Promise<CompletionResult | null> {
  const result = await getAutocompletion({
    env: input.env,
    path: input.path,
    context: input.context,
  });

  if (!result) return null;

  return {
    ...result,
    options: result.options.map((option) => {
      const details = input.env.languageService.getCompletionEntryDetails(
        input.path,
        input.context.pos,
        option.label,
        {},
        undefined,
        {},
        undefined,
      );
      const documentation = ts.displayPartsToString(details?.documentation ?? []).trim();
      return documentation ? { ...option, info: documentation } : option;
    }),
  };
}
