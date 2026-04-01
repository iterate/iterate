import type { CodemodeSource } from "@iterate-com/codemode-contract";
import { z } from "zod";
import { formatCodemodeSourcesYaml } from "~/lib/codemode-sources.ts";
import { CODEMODE_V2_STARTER } from "~/lib/codemode-v2.ts";

export const CodemodeNewRunSearchSchema = z.object({
  code: z.string().optional(),
  sources: z.string().optional(),
});

export const CodemodeExamplesSearchSchema = z.object({
  q: z.string().optional(),
});

export function buildCodemodeNewRunSearch(options: { code: string; sources: CodemodeSource[] }) {
  return {
    code: options.code,
    sources: formatCodemodeSourcesYaml(options.sources),
  };
}

export function buildCodemodeNewRunHref(options: {
  origin: string;
  code: string;
  sources: CodemodeSource[];
}) {
  const search = new URLSearchParams(buildCodemodeNewRunSearch(options));
  return `${options.origin}/runs-v2-new?${search.toString()}`;
}

export function resolveCodemodeEditorCode(code?: string) {
  return code?.trim().length ? code : CODEMODE_V2_STARTER;
}
