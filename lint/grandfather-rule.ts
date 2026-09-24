import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Rule } from "eslint";
import type { StrictRule } from "./types.ts";

/** Rule id → repository-relative path → the trimmed start line of each grandfathered report,
 * repeated once per report. */
export type GrandfatheredLines = Record<string, Record<string, string[]>>;
export type Baseline = { root: string; lines: GrandfatheredLines };

export const baselinePath = resolve(import.meta.dirname, "grandfathered.json");

/** `pnpm lint:baseline` sets this so every violation is reported, grandfathered or not. */
export const reportAllVariable = "LINT_BASELINE_REPORT_ALL";

/** Instances of grandfatherRule, so a test can match them against the baseline's rules. */
export const grandfatheredRules = new WeakSet<StrictRule>();

let repositoryBaseline: Baseline | undefined;

/** Suppress the reports that lint/grandfathered.json lists: a report is grandfathered while its
 * file's baseline for the rule still holds its start line's text. Each entry covers one report, so
 * a copied violation is new. An entry that nothing uses any more is itself an error, which makes the
 * baseline shrink as violations get fixed: lint/grandfather-rule.md.
 */
export function grandfatherRule(rule: StrictRule, baseline?: Baseline): StrictRule {
  const wrapped: StrictRule = {
    ...rule,
    create(context) {
      const { root, lines } = baseline || (repositoryBaseline ||= readBaseline());
      const path = relative(root, resolve(context.cwd, context.physicalFilename));
      const allowed = lines[context.id]?.[path];
      if (!allowed || process.env[reportAllVariable]) return rule.create(context);

      const remaining = new Map<string, number>();
      for (const text of allowed) remaining.set(text, (remaining.get(text) || 0) + 1);
      const sourceLines = context.sourceCode.lines;
      const listeners = rule.create(
        Object.create(context, {
          report: {
            value(descriptor: Rule.ReportDescriptor) {
              const location =
                ("loc" in descriptor && descriptor.loc) ||
                ("node" in descriptor && descriptor.node.loc);
              const line = location && ("start" in location ? location.start.line : location.line);
              const text = (line && sourceLines[line - 1]?.trim()) || "";
              const left = remaining.get(text) || 0;
              if (!left) return context.report(descriptor);
              remaining.set(text, left - 1);
            },
          },
        }),
      );
      const programExit = listeners["Program:exit"];
      return {
        ...listeners,
        "Program:exit"(node) {
          programExit?.(node);
          const stale = [...remaining.values()].reduce((sum, count) => sum + count, 0);
          if (stale)
            context.report({
              loc: { line: 1, column: 0 },
              message: `lint/grandfathered.json grandfathers ${stale} ${context.id} report(s) in this file that no longer occur. Run \`pnpm lint:baseline\` to drop them.`,
            });
        },
      };
    },
  };
  grandfatheredRules.add(wrapped);
  return wrapped;
}

export function readBaseline(): Baseline {
  return {
    root: resolve(import.meta.dirname, ".."),
    lines: JSON.parse(readFileSync(baselinePath, "utf8")) as GrandfatheredLines,
  };
}
