import { isMap, isScalar, parseDocument, visit } from "yaml";
import type { Document } from "yaml";
import type { DiagnosticCode } from "./types.ts";

// Restricted YAML for front matter: plain scalars, maps, and sequences only.
// Anchors, aliases, explicit tags, merge keys, non-string keys, duplicate
// keys, %YAML directives, unsafe keys, and deep nesting all reject the whole
// document — the codec falls back to plain rather than guessing what a
// surprising YAML feature meant.

const MAX_DEPTH = 64;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type FrontmatterYamlParse =
  | { ok: true; data: Record<string, unknown>; document: Document }
  | { ok: false; code: DiagnosticCode; message: string };

export function parseRestrictedFrontmatterYaml(text: string): FrontmatterYamlParse {
  const document = parseDocument(text, { uniqueKeys: true });
  const firstError = document.errors[0];
  if (firstError) {
    return {
      ok: false,
      code: "frontmatter-yaml-error",
      message: firstError.message.split("\n")[0] ?? "YAML error",
    };
  }
  if (document.directives.yaml.explicit) {
    return {
      ok: false,
      code: "frontmatter-yaml-error",
      message: "%YAML directives are not allowed",
    };
  }
  if (document.contents && !isMap(document.contents)) {
    return {
      ok: false,
      code: "frontmatter-not-a-map",
      message: "front matter must be a YAML mapping",
    };
  }
  let failure: { code: DiagnosticCode; message: string } | null = null;
  visit(document, {
    Alias() {
      failure = {
        code: "frontmatter-alias",
        message: "YAML aliases are not allowed in front matter",
      };
      return visit.BREAK;
    },
    Node(_key, node, path) {
      if (node.anchor) {
        failure = {
          code: "frontmatter-alias",
          message: "YAML anchors are not allowed in front matter",
        };
        return visit.BREAK;
      }
      if (node.tag) {
        failure = {
          code: "frontmatter-tag",
          message: `YAML tags are not allowed in front matter (${node.tag})`,
        };
        return visit.BREAK;
      }
      if (path.length > MAX_DEPTH) {
        failure = {
          code: "frontmatter-depth",
          message: `front matter nests deeper than ${MAX_DEPTH} levels`,
        };
        return visit.BREAK;
      }
      return undefined;
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value === "") {
        failure = {
          code: "frontmatter-not-a-map",
          message: "front matter keys must be plain strings",
        };
        return visit.BREAK;
      }
      if (pair.key.value === "<<") {
        failure = {
          code: "frontmatter-merge-key",
          message: "YAML merge keys are not allowed in front matter",
        };
        return visit.BREAK;
      }
      if (UNSAFE_KEYS.has(pair.key.value)) {
        failure = {
          code: "frontmatter-yaml-error",
          message: `unsafe front matter key \`${pair.key.value}\``,
        };
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (failure) return { ok: false, ...(failure as { code: DiagnosticCode; message: string }) };
  const data: Record<string, unknown> = !document.contents
    ? {}
    : ((document.toJS() ?? {}) as Record<string, unknown>);
  return { ok: true, data, document };
}
