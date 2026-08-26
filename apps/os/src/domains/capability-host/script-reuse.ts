/**
 * Script reuse: turn a previously journaled script into a parameterized
 * helper. `reparameterizeScript` swaps named literal occurrences for
 * identifiers server-side; `renderScriptReuseEnvelope` wraps the transformed
 * script with the caller's new values as consts. The envelope is what gets
 * submitted as a child script run, so the journal carries a self-contained,
 * auditable record of exactly what ran.
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

export function reparameterizeScript(input: {
  code: string;
  parameters: { name: string; content: string }[];
}): {
  code: string;
  parameterNames: string[];
} {
  const seen = new Set<string>();
  let code = input.code;
  for (const parameter of input.parameters) {
    const { name, content } = parameter;
    if (!IDENTIFIER_PATTERN.test(name) || RESERVED_WORDS.has(name)) {
      throw new Error(`Parameter name ${JSON.stringify(name)} is not a valid JS identifier.`);
    }
    if (seen.has(name)) {
      throw new Error(`Parameter name ${JSON.stringify(name)} appears more than once.`);
    }
    seen.add(name);
    if (content === "") {
      throw new Error(`Parameter ${JSON.stringify(name)} has empty content.`);
    }
    // Substitution is VALUE substitution, not text splicing: the occurrence
    // is replaced by the identifier and the identifier is bound to the
    // caller's runtime value. Live agents were observed passing a whole
    // `const n = 123n;` line (deleting the declaration leaves `n` dangling)
    // or a template-string interior (which would become the literal identifier
    // text inside the string) — reject both with the correct recipe.
    if (/[;\n]/.test(content) || /^\s*(const|let|var)\b/.test(content)) {
      throw new Error(
        `Parameter ${JSON.stringify(name)}: content must be the exact text of a single VALUE expression from the script (e.g. "23409823948238439732889n"), not a statement or line. The platform swaps that expression for the identifier ${JSON.stringify(name)} and binds your runtime vars value to it — so keep the script's \`const x = …\` structure and target only the value.`,
      );
    }
    if (content.includes("${") && !content.trimStart().startsWith("`")) {
      throw new Error(
        `Parameter ${JSON.stringify(name)}: content looks like the inside of a template string — swapping it would put the literal text ${JSON.stringify(name)} into the string. Target a value expression instead (a literal like "123n", or the whole backtick-quoted template).`,
      );
    }
    // The name will be injected as a `const` around the script; any existing
    // use of the same word in the script would shadow or collide with it.
    // (Word-boundary matching is deliberately conservative: `foo.number` also
    // rejects the name `number` — pick another name.)
    // `name` passed IDENTIFIER_PATTERN above, so it embeds in a regex verbatim.
    if (new RegExp(`\\b${name}\\b`).test(input.code)) {
      throw new Error(
        `Parameter name ${JSON.stringify(name)} already appears in the script text; pick a name the script does not use.`,
      );
    }
    const occurrences = code.split(content).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Parameter ${JSON.stringify(name)}: content ${JSON.stringify(content)} must appear exactly once in the script, found ${occurrences} occurrence(s).`,
      );
    }
    code = code.replace(content, name);
  }
  return { code, parameterNames: input.parameters.map((parameter) => parameter.name) };
}

/**
 * Render the child-run script: the caller's `vars` become consts (serialized
 * as JS literals, bigint included) that the re-parameterized script's free
 * identifiers close over. Uses `Itx` type annotations — the typecheck
 * prelude defines that alias, and the gate's emit strips them before the
 * script runs.
 *
 * Embedded into the execution harness via Function#toString (like
 * sandboxExecTimeout), so it must stay fully self-contained.
 */
export function renderScriptReuseEnvelope(input: {
  code: string;
  parameterNames: string[];
  vars: Record<string, unknown>;
}): string {
  function toJsLiteral(value: unknown, path: string): string {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => toJsLiteral(item, `${path}[${index}]`)).join(", ")}]`;
    }
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const entries = Object.entries(value).map(
        ([key, child]) => `${JSON.stringify(key)}: ${toJsLiteral(child, `${path}.${key}`)}`,
      );
      return `{ ${entries.join(", ")} }`;
    }
    throw new Error(
      `Script reuse vars must be JSON-style values (plus bigint); got ${typeof value} at ${path}`,
    );
  }
  const givenNames = Object.keys(input.vars);
  const missing = input.parameterNames.filter((name) => !givenNames.includes(name));
  const extra = givenNames.filter((name) => !input.parameterNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Script reuse vars must exactly match the declared parameter names [${input.parameterNames.join(", ")}]` +
        (missing.length > 0 ? `; missing: [${missing.join(", ")}]` : "") +
        (extra.length > 0 ? `; unexpected: [${extra.join(", ")}]` : ""),
    );
  }
  const consts = input.parameterNames
    .map((name) => `  const ${name} = ${toJsLiteral(input.vars[name], name)};`)
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
