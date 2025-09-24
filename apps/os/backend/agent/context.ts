import { dirname, join, resolve } from "path";
import { readFileSync, accessSync } from "fs";
import { fileURLToPath } from "url";
import { globSync } from "glob";
import YAML from "yaml";
import jsonataLib from "jsonata/sync";
import type {
  ContextRule,
  ContextRuleMatcher,
  MonthCode,
  TimeWindow,
  WeekdayCode,
} from "./context-schemas.ts";

export * from "./context-schemas.ts";

export function always() {
  return { type: "always" } satisfies ContextRuleMatcher;
}

export function never() {
  return { type: "never" } satisfies ContextRuleMatcher;
}

export function jsonata(expression: string) {
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function hasParticipant(searchString: string) {
  // Construct JSONata expression that checks if any participant contains the search string
  // This just stringifies the entire participants array
  const expression = `$contains($string(agentCoreState.participants), ${JSON.stringify(searchString)})`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function slackChannel(channelId: string) {
  // Construct JSONata expression that checks if slackChannelId matches the provided channel ID
  const expression = `agentCoreState.slackChannelId = "${channelId}"`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function and(...inner: ContextRuleMatcher[]) {
  return { type: "and", matchers: inner } satisfies ContextRuleMatcher;
}

export function or(...inner: ContextRuleMatcher[]) {
  return { type: "or", matchers: inner } satisfies ContextRuleMatcher;
}

export function not(inner: ContextRuleMatcher) {
  return { type: "not", matcher: inner } satisfies ContextRuleMatcher;
}

export function contextContains(searchString: string) {
  // Construct JSONata expression that searches across system prompt, input items,
  // ephemeral prompt fragments, and runtime tools
  const expression = `$contains(
    $string(agentCoreState.systemPrompt) &
    $string(agentCoreState.inputItems) &
    $string(agentCoreState.ephemeralPromptFragments) &
    $string(agentCoreState.runtimeTools),
    ${JSON.stringify(searchString)}
  )`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function hasTool(searchString: string) {
  // Construct JSONata expression that checks if any runtime tool contains the search string
  const expression = `$contains($string(agentCoreState.runtimeTools), ${JSON.stringify(searchString)})`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function hasMCPConnection(searchString: string) {
  // Construct JSONata expression that checks if any MCP connection's serverUrl or serverName contains the search string
  const expression = `$count(
    agentCoreState.mcpConnections.*[
      $contains($string(serverUrl), ${JSON.stringify(searchString)}) or
      $contains($string(serverName), ${JSON.stringify(searchString)})
    ]
  ) > 0`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export function forAgentClass(className: string) {
  // Construct JSONata expression that checks if durableObjectClassName matches the provided class name
  const expression = `durableObjectClassName = ${JSON.stringify(className)}`;
  return { type: "jsonata", expression } satisfies ContextRuleMatcher;
}

export const matchers = {
  never,
  always,
  jsonata,
  hasParticipant,
  slackChannel,
  contextContains,
  hasTool,
  hasMCPConnection,
  forAgentClass,
  and,
  or,
  not,
  timeWindow,
};

export const defineRule = <Rule extends ContextRule>(rule: Rule) => rule;

export const defineRules = <Rules extends ContextRule[]>(rules: Rules) => rules;

/**
 * Parse YAML front matter from a markdown string and return { attrs, body }.
 * If no front matter is present, attrs is {} and body is the original string.
 */
function parseFrontMatter(markdown: string): { attrs: Record<string, unknown>; body: string } {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/m.exec(markdown);
  if (!fm) return { attrs: {}, body: markdown };
  const yamlStr = fm[1] ?? "";
  let attrs: Record<string, unknown> = {};
  try {
    attrs = (YAML.parse(yamlStr) as Record<string, unknown>) ?? {};
  } catch {
    // ignore YAML errors; treat as no attrs
    attrs = {};
  }
  const body = markdown.slice(fm[0].length);
  //console.log("parseFrontMatter:", { hasFrontMatter: true, keys: Object.keys(attrs) });
  return { attrs, body };
}

/**
 * Convert a front-matter `match` (string or object) to a ContextRuleMatcher or array.
 * Supports expressions like always(), hasMCPConnection("foo"), and nested calls
 * using the exported `matchers` object.
 */
function parseMatchField(raw: unknown): ContextRule["match"] | undefined {
  //console.log("parseMatchField: raw:", raw);
  if (raw == null) return undefined;
  if (typeof raw === "object") {
    // Already structured as a matcher or array - pass through
    const result = raw as ContextRule["match"];
    const summary = Array.isArray(result)
      ? { kind: "array", types: result.map((m: any) => m?.type) }
      : { kind: "single", type: (result as any)?.type };
    //console.log("parseMatchField: structured matcher:", summary);
    return result;
  }
  if (typeof raw !== "string") return undefined;
  const expr = raw.trim();
  if (!expr) return undefined;
  try {
    // Evaluate the expression with `matchers` and all of its properties in scope.
    // This allows both `always()` and `matchers.always()` forms.
    const matcherNames = Object.keys(matchers);
    const argNames = ["matchers", ...matcherNames];
    // eslint-disable-next-line no-new-func -- Needed to evaluate tiny matcher DSL from front matter with restricted scope
    const fn = new Function(...argNames, `return (\n${expr}\n);`);
    const argValues = [matchers, ...matcherNames.map((k) => (matchers as any)[k])];
    const result = fn(...argValues);
    const summary = Array.isArray(result)
      ? { kind: "array", types: result.map((m: any) => m?.type) }
      : { kind: "single", type: (result as any)?.type };
    //console.log("parseMatchField: parsed matcher:", summary);
    return result as ContextRule["match"];
  } catch (err) {
    console.warn("Failed to parse match expression:", err);
    return undefined;
  }
}

/**
 * Build a ContextRule from a Markdown file's contents and path.
 * - Parses YAML front matter for { slug, match }
 * - Strips front matter from the prompt body
 * - Falls back to file path (sans .md) for key
 */
export function contextRuleFromMarkdownFile({
  fileContent,
  filePath,
  overrides = {},
}: {
  fileContent: string;
  filePath: string;
  overrides?: Partial<ContextRule>;
}): ContextRule {
  const { attrs, body } = parseFrontMatter(fileContent);
  const slug =
    typeof attrs.slug === "string" && attrs.slug.trim() ? (attrs.slug as string).trim() : undefined;
  const match = parseMatchField((attrs as any)?.match);
  const key = slug ?? filePath.replace(/\.md$/, "");
  const matchSummary = Array.isArray(match)
    ? { kind: "array", types: match.map((m: any) => m?.type) }
    : { kind: match ? "single" : "none", type: (match as any)?.type };
  const matchRaw = (attrs as any)?.match;
  console.log("contextRuleFromMarkdownFile:", {
    filePath,
    key,
    slug,
    hasMatch: Boolean(match),
    matchRaw,
    matchSummary,
  });
  return defineRule({ key, prompt: body, match, ...overrides });
}

/**
 * Evaluates whether a context rule should be applied based on its matchers.
 * Returns true if the rule should be included, false otherwise.
 *
 * @param params Object containing contextRule and matchAgainst data
 * @param params.contextRule The context rule containing the matchers to evaluate
 * @param params.matchAgainst Object to evaluate the matchers against
 * @returns true if any matcher matches (or if matchers array is empty/undefined), false otherwise
 */
export function evaluateContextRuleMatchers({
  contextRule,
  matchAgainst,
}: {
  contextRule: Pick<ContextRule, "match">;
  matchAgainst: unknown;
}): boolean {
  const matcher: ContextRuleMatcher = Array.isArray(contextRule.match)
    ? { type: "or", matchers: contextRule.match }
    : contextRule.match || { type: "always" };
  return evaluateSingleMatcher(matchAgainst, matcher);
}

function evaluateSingleMatcher(matchAgainst: unknown, matcher: ContextRuleMatcher): boolean {
  switch (matcher.type) {
    case "always":
      return true;

    case "never":
      return false;

    case "jsonata": {
      // If the jsonata expression is invalid, this will throw an error
      // We may want to log a warning and return false in the future, but for now we like the error
      const result = jsonataLib(matcher.expression).evaluate(matchAgainst);
      return Boolean(result);
    }

    case "and": {
      const results = matcher.matchers.map((inner) => {
        return evaluateSingleMatcher(matchAgainst, inner);
      });
      return results.every(Boolean);
    }

    case "or": {
      const results = matcher.matchers.map((inner) => {
        return evaluateSingleMatcher(matchAgainst, inner);
      });
      return results.some(Boolean);
    }

    case "not": {
      const inner = evaluateSingleMatcher(matchAgainst, matcher.matcher);
      return !inner;
    }
    case "timeWindow": {
      const tz = matcher.tz ?? "UTC";
      const nowMs = Date.now();
      const local = getLocalDateParts(nowMs, tz);
      // OR across windows
      for (const window of matcher.windows) {
        if (doesWindowMatch(local, window)) {
          return true;
        }
      }
      return false;
    }
    default: {
      matcher satisfies never;
      throw new Error(`Unknown matcher type: ${(matcher as ContextRuleMatcher).type}`);
    }
  }
}

function timeWindow(windows: TimeWindow | TimeWindow[], opts?: { tz?: string }) {
  const arr = Array.isArray(windows) ? windows : [windows];
  return { type: "timeWindow", windows: arr, tz: opts?.tz } as const;
}

type LocalDateParts = {
  /** 0=Sunday..6=Saturday */
  weekday: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
};

function getLocalDateParts(timestampMs: number, timeZone: string): LocalDateParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(timestampMs));

  const toNumber = (type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value ?? "0";
    return Number(v);
  };

  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);

  return {
    weekday: weekday < 0 ? 0 : weekday,
    month: toNumber("month"),
    day: toNumber("day"),
    hour: toNumber("hour"),
    minute: toNumber("minute"),
  };
}

function doesWindowMatch(local: LocalDateParts, window: TimeWindow): boolean {
  // exact match short-circuit
  if (window.exact) {
    const { month, day, hour, minute } = window.exact;
    if (
      local.month !== month ||
      local.day !== day ||
      local.hour !== hour ||
      local.minute !== minute
    ) {
      return false;
    }
  }

  if (window.weekdays && window.weekdays.length > 0) {
    const allowed = new Set<number>(window.weekdays.map(normalizeWeekday));
    if (!allowed.has(local.weekday)) {
      return false;
    }
  }

  if (window.months && window.months.length > 0) {
    const allowed = new Set<number>(window.months.map(normalizeMonth));
    if (!allowed.has(local.month)) {
      return false;
    }
  }

  if (window.daysOfMonth && window.daysOfMonth.length > 0) {
    const allowed = new Set<number>(window.daysOfMonth);
    if (!allowed.has(local.day)) {
      return false;
    }
  }

  if (window.timeOfDay) {
    const start = parseHm(window.timeOfDay.start);
    const end = parseHm(window.timeOfDay.end);
    const minutesNow = local.hour * 60 + local.minute;
    if (start <= end) {
      if (minutesNow < start || minutesNow >= end) {
        return false;
      }
    } else {
      // Cross-midnight window: e.g., 22:00-06:00 means [22:00..24:00) U [00:00..06:00)
      if (!(minutesNow >= start || minutesNow < end)) {
        return false;
      }
    }
  }

  return true;
}

function normalizeWeekday(input: number | WeekdayCode): number {
  if (typeof input === "number") {
    // Expect 0..6 with 0=Sunday
    if (input < 0 || input > 6) {
      throw new Error(`Invalid weekday number: ${input}`);
    }
    return input;
  }
  const map: Record<WeekdayCode, number> = {
    SU: 0,
    MO: 1,
    TU: 2,
    WE: 3,
    TH: 4,
    FR: 5,
    SA: 6,
  };
  return map[input];
}

function normalizeMonth(input: number | MonthCode): number {
  if (typeof input === "number") {
    if (input < 1 || input > 12) {
      throw new Error(`Invalid month number: ${input}`);
    }
    return input;
  }
  const map: Record<MonthCode, number> = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  };
  return map[input];
}

function parseHm(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) {
    throw new Error(`Invalid HH:mm string: ${hhmm}`);
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`Invalid HH:mm value: ${hhmm}`);
  }
  return h * 60 + min;
}

/**
 * Helper function to create context rules from files matching a glob pattern.
 * Each file becomes a context rule with slug derived from filename and prompt from file content.
 */
export function contextRulesFromFiles(pattern: string, overrides: Partial<ContextRule> = {}) {
  try {
    // Resolve pattern relative to the config file's directory
    const configDir = findIterateConfig();
    if (!configDir) {
      throw new Error("iterate.config.ts not found");
    }
    //console.log("contextRulesFromFiles:", { pattern, configDir });
    const files = globSync(pattern, { cwd: configDir }) as string[];
    //console.log("contextRulesFromFiles: files:", files);
    return files.map((filePath: string) => {
      const fileContent = readFileSync(join(configDir, filePath), "utf-8");
      // Use helper to parse front matter and match expression
      return contextRuleFromMarkdownFile({ fileContent, filePath, overrides });
    });
  } catch (error) {
    console.error(`Error reading files with pattern ${pattern}:`, error);
    return [];
  }
}

const findIterateConfig = (root: string = process.cwd()): string | null => {
  // 1) If provided, honor explicit env var path
  const envPath = process.env.ITERATE_CONFIG_PATH;
  if (envPath) {
    const candidates = [
      resolve(root, envPath),
      // common when running from apps/os and providing repo-root-relative path
      resolve(root, "..", "..", envPath),
    ];
    for (const candidate of candidates) {
      try {
        accessSync(candidate);
        return dirname(candidate);
      } catch {
        // try next candidate
      }
    }
  }

  // 2) Try to infer from the call stack (works when called from iterate.config.ts)
  try {
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n");
    for (const line of lines) {
      if (!line.includes("iterate.config.ts")) continue;

      // file URL form
      const fileUrlMatch = line.match(/(file:\/\/[^^\s)]+?\/iterate\.config\.ts)/);
      if (fileUrlMatch) {
        const abs = fileURLToPath(fileUrlMatch[1]);
        return dirname(resolve(abs));
      }

      // POSIX absolute path
      const posixMatch = line.match(/(\/[^^\s)]+?\/iterate\.config\.ts)/);
      if (posixMatch) {
        return dirname(resolve(posixMatch[1]));
      }

      // Windows absolute path
      const winMatch = line.match(/([A-Za-z]:\\[^\s)]+?\\iterate\.config\.ts)/);
      if (winMatch) {
        return dirname(resolve(winMatch[1]));
      }
    }
  } catch {
    // ignore call stack parsing errors
  }

  // 3) Fallback: walk upwards from cwd (works if cwd is the estate dir)
  let currentDir = resolve(root);
  const rootDir = resolve("/");
  while (currentDir !== rootDir) {
    const configPath = join(currentDir, "iterate.config.ts");
    try {
      accessSync(configPath);
      return currentDir;
    } catch {
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }

  // 4) Not found
  return null;
};
