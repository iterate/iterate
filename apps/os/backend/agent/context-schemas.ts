import type { RequireAtLeastOne } from "type-fest";
import { z } from "zod";
import { PromptFragment } from "./prompt-fragments.ts";
import { MCPServer, ToolSpec, type MCPServerInput } from "./tool-schemas.ts";

export type ContextRuleMatcher =
  | { type: "always" }
  | { type: "never" }
  | { type: "jsonata"; expression: string }
  | { type: "and"; matchers: ContextRuleMatcher[] }
  | { type: "or"; matchers: ContextRuleMatcher[] }
  | { type: "not"; matcher: ContextRuleMatcher }
  | { type: "timeWindow"; windows: TimeWindow[]; tz?: string };

export const ContextRuleMatcher = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal("always"),
    }),
    z.object({
      type: z.literal("never"),
    }),
    z.object({
      type: z.literal("jsonata"),
      expression: z.string(),
    }),
    z.object({
      type: z.literal("and"),
      matchers: z.array(ContextRuleMatcher),
    }),
    z.object({
      type: z.literal("or"),
      matchers: z.array(ContextRuleMatcher),
    }),
    z.object({
      type: z.literal("not"),
      matcher: ContextRuleMatcher,
    }),
    z.object({
      type: z.literal("timeWindow"),
      windows: z.array(z.lazy(() => TimeWindow)),
      tz: z.string().optional(),
    }),
  ]),
) as z.ZodType<ContextRuleMatcher>; // todo: ask colinhacks why lazy doesn't work here?

export const WeekdayCode = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
export type WeekdayCode = z.infer<typeof WeekdayCode>;
export const MonthCode = z.enum([
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
]);
export type MonthCode = z.infer<typeof MonthCode>;

export const TimeWindow = z.object({
  /** 0=Sunday..6=Saturday or iCal-style weekday codes */
  weekdays: z.array(WeekdayCode.or(z.number().int().min(0).max(6))).optional(),
  /** 1..12 or month codes */
  months: z.array(MonthCode.or(z.number().int().min(1).max(12))).optional(),
  /** Time interval in local day. Cross-midnight allowed when end < start */
  daysOfMonth: z.array(z.number().int().min(1).max(31)).optional(),
  /** Time interval in local day. Cross-midnight allowed when end < start */
  timeOfDay: z.object({ start: z.string(), end: z.string() }).optional(),
  /** Exact month/day/hour/minute match in local time */
  exact: z
    .object({
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .optional(),
});
export type TimeWindow = z.infer<typeof TimeWindow>;
/**
 * Represents context (such as prompts and tool specs) to be provided to
 * an LLM via our AgentCore class
 */

export type ContextItem = RequireAtLeastOne<{
  prompt: PromptFragment;
  tools: ToolSpec[];
  mcpServers: MCPServerInput[];
}> & {
  key: string;
  description?: string;
};
export const ContextItem = z.object({
  key: z.string(),
  description: z.string().optional(),
  prompt: PromptFragment.optional(),
  tools: z.array(ToolSpec).optional(),
  mcpServers: z.array(MCPServer).optional(),
}) satisfies z.ZodType<{
  [K in keyof ContextItem]: ContextItem[K];
}>;

export const ContextRule = z.preprocess(
  (input: { key?: string; id?: string }) => ({ ...input, key: input.key ?? input.id }),
  ContextItem.extend({
    /**
     * Matcher for when this context rule should apply.
     * Prefer providing a single matcher and compose with matchers.and/or/not.
     *
     * If an array is provided, it is treated as matchers.or(...array).
     */
    match: ContextRuleMatcher.or(z.array(ContextRuleMatcher)).optional(),
  }),
);
export type ContextRule = z.infer<typeof ContextRule>;
