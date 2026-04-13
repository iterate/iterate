import type { CodemodeInput, CodemodeSource } from "@iterate-com/codemode-contract";
import { z } from "zod";
import { resolveCodemodeEditorInput, serializeCodemodeInput } from "~/lib/codemode-input.ts";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";

export const CodemodeNewRunSearch = z.object({
  input: z.string().optional(),
  code: z.string().optional(),
  sources: z.string().optional(),
});

export const CodemodeExamplesSearch = z.object({
  q: z.string().optional(),
});

export function buildCodemodeNewRunSearch(options: {
  input?: CodemodeInput;
  code?: string;
  sources: CodemodeSource[];
}) {
  const input = options.input ?? resolveCodemodeEditorInput({ code: options.code });

  return {
    input: serializeCodemodeInput(input),
    sources: formatCodemodeSourcesYaml(options.sources),
  };
}

export function buildCodemodeNewRunHref(options: {
  origin: string;
  input?: CodemodeInput;
  code?: string;
  sources: CodemodeSource[];
}) {
  const search = new URLSearchParams(buildCodemodeNewRunSearch(options));
  return `${options.origin}/runs-v2-new?${search.toString()}`;
}

export function resolveCodemodeSearchInput(search: { input?: string; code?: string }) {
  return resolveCodemodeEditorInput(search);
}
