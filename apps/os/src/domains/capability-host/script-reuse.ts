/**
 * Script reuse: turn a previously journaled script into a parameterized
 * helper (`itx.capabilityHost.previousScriptHelper`). Parameters are given
 * as VALUES (`{ n: 1234567890n }`): the platform renders each value's
 * candidate literal spellings, finds the one occurrence in the script, and
 * swaps it for a generated ALIAS identifier — aliases are unique by
 * construction, so parameter names never have to avoid the script's own
 * identifiers, and the value shape lets `run(vars)` be TYPED from the
 * parameters object. `renderScriptReuseEnvelope` wraps the transformed
 * script with the new values bound to those aliases. The envelope is what
 * gets submitted as a child script run, so the journal carries a
 * self-contained, auditable record of exactly what ran.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Words that pass the identifier regex but cannot be `const` names.
const RESERVED_WORDS = new Set([
  ...(
    "break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for function if import in instanceof new null return super switch this throw " +
    "true try typeof var void while with yield let static await async"
  ).split(" "),
]);

/** A reusable-script parameter value: a primitive whose literal text can be
 * located in the script. Objects/arrays never appear as one inline literal
 * reliably, so they are excluded on purpose. */
export type ScriptReuseValue = string | number | boolean | bigint;

export type ReuseParameterBinding = {
  alias: string;
  kind: "bigint" | "boolean" | "number" | "string";
  name: string;
};

export function reparameterizeScript(input: {
  code: string;
  parameters: Record<string, ScriptReuseValue>;
}): {
  code: string;
  parameters: ReuseParameterBinding[];
} {
  const bindings: ReuseParameterBinding[] = [];
  let code = input.code;
  for (const [name, value] of Object.entries(input.parameters)) {
    if (!IDENTIFIER_PATTERN.test(name) || RESERVED_WORDS.has(name)) {
      throw new Error(`Parameter name ${JSON.stringify(name)} is not a valid JS identifier.`);
    }
    const kind = typeof value;
    if (kind !== "string" && kind !== "number" && kind !== "boolean" && kind !== "bigint") {
      throw new Error(
        `Parameter ${JSON.stringify(name)} must be a string, number, boolean, or bigint (its literal text is located in the script); got ${kind}.`,
      );
    }
    if (value === "") {
      throw new Error(
        `Parameter ${JSON.stringify(name)} is an empty string — too ambiguous to locate in the script.`,
      );
    }
    // The script may spell the same value more than one way; try each
    // spelling and require exactly one occurrence in total. Quoted string
    // spellings are self-delimiting; numeric/boolean/bigint spellings need
    // boundaries so 42 cannot match inside 142, 42.5, or x42.
    const spellings = literalSpellings(value);
    const counts = spellings.map((spelling) => {
      const matcher =
        kind === "string"
          ? undefined
          : new RegExp(`(?<![\\w$.])${spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$.])`);
      const occurrences =
        matcher === undefined
          ? code.split(spelling).length - 1
          : (code.match(new RegExp(matcher.source, "g")) || []).length;
      return { matcher, occurrences, spelling };
    });
    const total = counts.reduce((sum, entry) => sum + entry.occurrences, 0);
    if (total !== 1) {
      const detail = counts.map((entry) => `${entry.spelling} (${entry.occurrences})`).join(", ");
      throw new Error(
        `Parameter ${JSON.stringify(name)}: the value's literal must appear exactly once in the script; searched ${detail} — ${total} total occurrence(s).`,
      );
    }
    const match = counts.find((entry) => entry.occurrences === 1)!;
    // The swapped-in identifier is a generated alias, deterministic (replays
    // and idempotency keys must agree) and unique against both the evolving
    // script text and earlier aliases — the caller's `name` never collides
    // with anything the script already says.
    let alias = `__reuse_${name}`;
    for (let suffix = 2; new RegExp(`\\b${alias}\\b`).test(code); suffix++) {
      alias = `__reuse_${name}_${suffix}`;
    }
    code = code.replace(match.matcher || match.spelling, alias);
    bindings.push({ alias, kind, name });
  }
  return { code, parameters: bindings };
}

/** The literal spellings a script might plausibly use for a primitive value —
 * canonical first. Strings get quote variants only when no escaping would be
 * needed; exotic numeric spellings (1e6, 0x10) are not chased. */
function literalSpellings(value: ScriptReuseValue): string[] {
  if (typeof value === "boolean") return [String(value)];
  // Deduped: for short numbers delimit() returns the canonical spelling and a
  // duplicate would double-count every occurrence, breaking exactly-once.
  if (typeof value === "bigint") return [...new Set([`${value}n`, `${delimit(String(value))}n`])];
  if (typeof value === "number") return [...new Set([String(value), delimit(String(value))])];
  const spellings = [JSON.stringify(value)];
  if (!/[\\'\n\r]/.test(value)) spellings.push(`'${value}'`);
  if (!/[\\`\n\r]/.test(value) && !value.includes("${")) spellings.push(`\`${value}\``);
  return spellings;
}

/** "1234567" → "1_234_567": thousands-grouped integer digits, the one
 * separator convention people actually type. The sign and any fraction pass
 * through ungrouped; anything else (exponent forms, <4 digits) returns
 * unchanged. */
function delimit(number: string): string {
  const match = /^(-?)(\d{4,})((?:\.\d+)?)$/.exec(number);
  if (match === null) return number;
  return match[1] + match[2].replace(/\B(?=(\d{3})+$)/g, "_") + match[3];
}

/**
 * Render the child-run script: the caller's `vars` become consts (serialized
 * as literals) bound to the generated aliases, which the re-parameterized
 * script's swapped expressions read. Uses `Itx` type annotations — the
 * typecheck prelude defines that alias, and the gate's emit strips them
 * before the script runs.
 */
export function renderScriptReuseEnvelope(input: {
  code: string;
  parameters: ReuseParameterBinding[];
  vars: Record<string, unknown>;
}): string {
  const names = input.parameters.map((binding) => binding.name);
  const givenNames = Object.keys(input.vars);
  const missing = names.filter((name) => !givenNames.includes(name));
  const extra = givenNames.filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `run() vars must exactly match the declared parameter names [${names.join(", ")}]` +
        (missing.length > 0 ? `; missing: [${missing.join(", ")}]` : "") +
        (extra.length > 0 ? `; unexpected: [${extra.join(", ")}]` : ""),
    );
  }
  const consts = input.parameters
    .map((binding) => {
      const value = input.vars[binding.name];
      // The typecheck gate enforces this statically for agent scripts; these
      // are the same messages for runtimes the gate does not cover (the CLI
      // runtime, direct RPC callers).
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean" &&
        typeof value !== "bigint"
      ) {
        throw new Error(
          `run() var ${JSON.stringify(binding.name)} must be a primitive; got ${typeof value}.`,
        );
      }
      if (typeof value !== binding.kind) {
        throw new Error(
          `run() var ${JSON.stringify(binding.name)} must be a ${binding.kind} (the original parameter's type); got ${typeof value}.`,
        );
      }
      return `  const ${binding.alias} = ${primitiveLiteral(value)};`;
    })
    .join("\n");
  return [
    `async (itx: Itx) => {`,
    consts,
    `  const __reusedScript: (itx: Itx, ...rest: any[]) => unknown = (`,
    input.code,
    `  );`,
    `  return await __reusedScript(itx);`,
    `}`,
  ].join("\n");
}

function primitiveLiteral(value: ScriptReuseValue): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}
