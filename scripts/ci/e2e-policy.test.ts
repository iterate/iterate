import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  E2E_BUDGET_EXEMPTIONS,
  E2E_CI_RETRIES,
  E2E_ROW_TIMEOUT_CEILING_MS,
  E2E_SLEEP_CEILING_MS,
  E2E_SLOW_ROW_TIMEOUT_MS,
  e2eRowTimeoutCeilingMs,
  SLOW_ROW_PATHS,
} from "@iterate-com/shared/test-support/e2e-policy";
import ts from "typescript";
import { expect, onTestFinished, test } from "vitest";

// THE E2E ROW BUDGET, read from source (docs/testing.md#the-row-budget). The e2e run starts every
// file at once and every row within a file concurrently, so it lasts its startup plus its slowest
// row. This guard reads every row of the e2e project with the TypeScript parser: the timeout it
// declares (options, trailing argument, or a createFlake / createFailing deadline), its tags, the
// gate it runs behind, and every fixed wait inside it. A row gated on an opt-in variable
// (`RUN_*`, `E2E_REAL_MODELS`) or on a local worker (`localOnly`) runs in no PR's e2e job, which
// targets the PR's preview, so neither budget applies to it. A row tagged `slow` runs only on the PRs
// that change its code (docs/testing.md#slow-rows): its waits are its own, and its timeout may reach
// `E2E_SLOW_ROW_TIMEOUT_MS`.

const repoRoot = resolve(import.meta.dirname, "../..");
const osRoot = join(repoRoot, "apps/os");
/** Where the e2e project's rows and their support modules live (apps/os/vitest.config.ts). */
const E2E_DIRECTORIES = ["apps/os/e2e", "apps/agents/e2e"];

const scan = scanE2eRows(E2E_DIRECTORIES.map((directory) => join(repoRoot, directory)));
const defaultTimeoutMs = Number(e2eProjectOptions().testTimeout?.replaceAll("_", ""));

test("the e2e run keeps its parallelism: every file at once, every row in a file concurrent", () => {
  const scripts = JSON.parse(readFileSync(join(osRoot, "package.json"), "utf8")).scripts;
  expect(scripts["e2e:run"]).toMatch(/--project e2e\b/);
  expect(scripts["e2e:run"]).toContain("--sequence.concurrent");
  expect(e2eProjectOptions()).toMatchObject({
    include: '["e2e/**/*.e2e.test.ts", "../agents/e2e/**/*.e2e.test.ts"]',
    fileParallelism: "true",
    maxWorkers: "process.env.CI ? 16 : undefined",
    maxConcurrency: "32",
    retry: "process.env.CI ? E2E_CI_RETRIES : 0",
    strictTags: "true",
  });
  expect(e2eProjectOptions().tags).toMatch(/name: "slow",[^}]*timeout: E2E_SLOW_ROW_TIMEOUT_MS,/u);
  expect(defaultTimeoutMs).toBeLessThanOrEqual(E2E_ROW_TIMEOUT_CEILING_MS);
});

test("E2E_CI_RETRIES is the one retry setting an e2e row has", () => {
  expect(E2E_CI_RETRIES).toBe(1);
  expect(scan.retrySettings.length).toBeGreaterThan(0);
  expect(
    scan.retrySettings.filter(
      (setting) => !["0", "process.env.CI ? E2E_CI_RETRIES : 0"].includes(setting.value),
    ),
  ).toEqual([]);
});

test(`no e2e row that runs on every PR declares a timeout over ${E2E_ROW_TIMEOUT_CEILING_MS / 1000} s`, () => {
  expect(scan.rows.filter((row) => row.onPrs).length).toBeGreaterThan(250);
  const violations = timeoutViolations(scan.rows, defaultTimeoutMs);
  expect(
    violations,
    `A hung row holds the run for its timeout. Make the row faster, or tag it "slow" if it waits real platform time (docs/testing.md#the-row-budget):\n${violations.join("\n")}`,
  ).toEqual([]);
});

test(`no e2e row that runs on every PR waits longer than ${E2E_SLEEP_CEILING_MS / 1000} s`, () => {
  const violations = waitViolations(scan);
  expect(
    violations,
    `Poll for the condition instead (\`until\`, \`expect.poll\`). A row that must wait out real platform time is a "slow" row (docs/testing.md#the-row-budget):\n${violations.join("\n")}`,
  ).toEqual([]);
});

test("every exempt title names one row that runs on every PR and is not tagged slow", () => {
  const stale = Object.keys(E2E_BUDGET_EXEMPTIONS).flatMap((title) => {
    const matching = scan.rows.filter((row) => row.title === title && row.onPrs);
    if (matching.length !== 1) return [`${matching.length} rows titled: ${title}`];
    return matching[0]!.slow ? [`tagged slow, so it needs no exemption: ${title}`] : [];
  });
  expect(stale).toEqual([]);
});

// A PR runs the rows tagged slow when it changes a file of SLOW_ROW_PATHS (apps/os/scripts/slow-rows.ts),
// so a slow row's own file is one: a PR that edits the row runs it.
test("every file with a row tagged slow is in SLOW_ROW_PATHS", () => {
  const files = scan.rows.filter((row) => row.slow).map((row) => row.at.replace(/:\d+$/u, ""));
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((file) => !SLOW_ROW_PATHS.includes(file))).toEqual([]);
});

test("every SLOW_ROW_PATHS entry is a file in the repository", () => {
  expect(SLOW_ROW_PATHS.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([]);
});

test("the guard reads each way a row declares its timeout, its gate and its waits", () => {
  const directory = mkdtempSync(join(tmpdir(), "e2e-policy-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "support"));
  writeFileSync(
    join(directory, "support/gates.ts"),
    [
      'import { test } from "vitest";',
      "export const projectHostsAreLocal = () => true;",
      "export const localOnly = test.skipIf(!projectHostsAreLocal());",
      "export const deployedOnly = test.skipIf(projectHostsAreLocal());",
      "export const SEED_MS = 60_000 + 30_000;",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "rows.e2e.test.ts"),
    [
      'import { test } from "vitest";',
      'import { createFlake } from "@iterate-com/shared/test-support/flake-test";',
      'import { deployedOnly, localOnly, SEED_MS } from "./support/gates.ts";',
      'const OPT_IN = process.env.RUN_PROBE === "1";',
      "const probe = test.skipIf(!OPT_IN);",
      "const flake = createFlake(test, /x/, { timeoutMs: 120_000 });",
      "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
      'test("trailing", async () => {}, 120_000);',
      'deployedOnly.sequential("options", { timeout: SEED_MS + 1 }, async () => {});',
      'test("default", async () => { await sleep(31_000); });',
      'test("deadline", async () => { setTimeout(() => reject(new Error("late")), 60_000); });',
      'flake("wrapped", async () => {});',
      'localOnly("local", { timeout: 300_000 }, async () => {});',
      'probe("opt-in", { timeout: 300_000 }, async () => { await sleep(300_000); });',
      'test("slow", { tags: ["slow"], timeout: 300_000 }, async () => { await sleep(180_000); });',
      'test("too slow", { tags: ["slow"], timeout: 301_000 }, async () => {});',
      "sleep(45_000);",
    ].join("\n"),
  );
  const fixture = scanE2eRows([directory]);
  const lines = (violations: string[]) => violations.map((line) => line.replace(/^.*?:/u, ""));
  expect(lines(timeoutViolations(fixture.rows, 60_000))).toEqual([
    "8 declares 120 s, over 90 s — trailing",
    "9 declares 90.001 s, over 90 s — options",
    "12 declares 121 s, over 90 s — wrapped",
    "16 declares 301 s, over 300 s — too slow",
  ]);
  expect(lines(waitViolations(fixture))).toEqual([
    "10 waits 31 s — default",
    "17 waits 45 s outside any row",
  ]);
});

function timeoutViolations(rows: E2eRow[], defaultTimeoutMs: number) {
  return rows.flatMap((row) => {
    if (!row.onPrs) return [];
    // a row tagged `slow` without its own timeout takes the tag's
    const timeoutMs = row.timeoutMs ?? (row.slow ? E2E_SLOW_ROW_TIMEOUT_MS : defaultTimeoutMs);
    const ceilingMs = e2eRowTimeoutCeilingMs(row);
    if (timeoutMs === "unreadable")
      return [`${row.at} declares a timeout this guard cannot read — ${row.title}`];
    return timeoutMs > ceilingMs
      ? [`${row.at} declares ${timeoutMs / 1000} s, over ${ceilingMs / 1000} s — ${row.title}`]
      : [];
  });
}

function waitViolations(scanned: ReturnType<typeof scanE2eRows>) {
  return [
    ...scanned.rows.flatMap((row) =>
      !row.onPrs || row.slow || E2E_BUDGET_EXEMPTIONS[row.title]
        ? []
        : row.sleeps.map((sleep) => `${sleep.at} waits ${sleep.ms / 1000} s — ${row.title}`),
    ),
    ...scanned.looseSleeps.map((sleep) => `${sleep.at} waits ${sleep.ms / 1000} s outside any row`),
  ];
}

type E2eRow = {
  at: string;
  title: string;
  /** Undefined when the row declares none and takes the project's `testTimeout`. */
  timeoutMs: number | "unreadable" | undefined;
  /** False behind an opt-in variable or a local-worker gate: the PR's e2e job never starts it. */
  onPrs: boolean;
  slow: boolean;
  sleeps: { at: string; ms: number }[];
};

type Scope = { file: string; source: ts.SourceFile; locals: Map<string, ts.Expression> };

function scanE2eRows(directories: string[]) {
  const files = directories.flatMap(tsFilesBelow).sort();
  const scopes = new Map<string, Scope>();
  const scopeOf = (file: string) => {
    const cached = scopes.get(file);
    if (cached) return cached;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const locals = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          locals.set(declaration.name.text, declaration.initializer);
    }
    const scope = { file, source, locals };
    scopes.set(file, scope);
    return scope;
  };
  const rows: E2eRow[] = [];
  const looseSleeps: { at: string; ms: number }[] = [];
  const retrySettings: { at: string; value: string }[] = [];

  for (const file of files) {
    const scope = scopeOf(file);
    const rowsByCall = new Map<ts.Node, E2eRow>();
    const visitRows = (node: ts.Node) => {
      if (ts.isCallExpression(node) && file.endsWith(".e2e.test.ts")) {
        const row = rowOf(node, scope);
        if (row) {
          rowsByCall.set(node, row);
          rows.push(row);
        }
      }
      ts.forEachChild(node, visitRows);
    };
    visitRows(scope.source);
    const visitWaits = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && /^retr(y|ies)$/u.test(node.name.getText()))
        retrySettings.push({ at: at(scope, node), value: node.initializer.getText() });
      const ms = ts.isCallExpression(node) ? fixedWaitMs(node, scope) : undefined;
      if (ms !== undefined && ms > E2E_SLEEP_CEILING_MS) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !rowsByCall.has(owner)) owner = owner.parent;
        const wait = { at: at(scope, node), ms };
        if (owner) rowsByCall.get(owner)!.sleeps.push(wait);
        else looseSleeps.push(wait);
      }
      ts.forEachChild(node, visitWaits);
    };
    visitWaits(scope.source);
  }
  return { rows, looseSleeps, retrySettings };

  function rowOf(call: ts.CallExpression, scope: Scope): E2eRow | undefined {
    const [title, second, third] = call.arguments;
    if (!title || !call.arguments.some(isFunction)) return undefined;
    const registration = registrationOf(call.expression, scope);
    if (!registration) return undefined;
    const options = [second, third].find(
      (argument): argument is ts.ObjectLiteralExpression =>
        !!argument && ts.isObjectLiteralExpression(argument),
    );
    const declared = options
      ? property(options, "timeout")
      : second && isFunction(second)
        ? third
        : undefined;
    const tags = options && property(options, "tags");
    return {
      at: at(scope, call),
      title: ts.isStringLiteralLike(title) ? title.text : title.getText(),
      timeoutMs:
        registration.deadlineMs ??
        (declared ? (evaluate(declared, scope) ?? "unreadable") : undefined),
      onPrs: registration.onPrs,
      slow:
        !!tags &&
        ts.isArrayLiteralExpression(tags) &&
        tags.elements.some((tag) => ts.isStringLiteralLike(tag) && tag.text === "slow"),
      sleeps: [],
    };
  }

  type Registration = { onPrs: boolean; deadlineMs?: number | "unreadable" };

  /** How a callee registers a row: vitest's `test`, a gate or wrapper around it, or nothing. */
  function registrationOf(expression: ts.Expression, scope: Scope): Registration | undefined {
    if (ts.isParenthesizedExpression(expression))
      return registrationOf(expression.expression, scope);
    if (ts.isIdentifier(expression)) {
      const imported = importOf(expression.text, scope);
      if (imported?.module === "vitest")
        return ["test", "it"].includes(imported.name) ? { onPrs: true } : undefined;
      if (imported?.file) {
        const exported = scopeOf(imported.file);
        const initializer = exported.locals.get(imported.name);
        return initializer ? registrationOf(initializer, exported) : undefined;
      }
      const initializer = scope.locals.get(expression.text);
      return initializer ? registrationOf(initializer, scope) : undefined;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const base = registrationOf(expression.expression, scope);
      if (!base) return undefined;
      if (["skip", "todo"].includes(expression.name.text)) return { ...base, onPrs: false };
      return ["sequential", "concurrent", "fails", "only"].includes(expression.name.text)
        ? base
        : undefined;
    }
    if (!ts.isCallExpression(expression)) return undefined;
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const base = registrationOf(callee.expression, scope);
      if (!base) return undefined;
      if (["for", "each"].includes(callee.name.text)) return base;
      if (!["skipIf", "runIf"].includes(callee.name.text)) return undefined;
      const [condition] = expression.arguments;
      return { ...base, onPrs: base.onPrs && !(condition && skipsOnPrs(condition, scope)) };
    }
    const wrapper = ts.isIdentifier(callee) ? importOf(callee.text, scope) : undefined;
    if (!wrapper || !["createFlake", "createFailing"].includes(wrapper.name)) return undefined;
    const [wrapped, , options] = expression.arguments;
    const base = wrapped && registrationOf(wrapped, scope);
    if (!base) return undefined;
    // The wrappers set the runner's timeout to their own deadline plus a second (flake-test.ts).
    const deadline =
      options && ts.isObjectLiteralExpression(options) ? property(options, "timeoutMs") : undefined;
    const deadlineMs = deadline ? evaluate(deadline, scope) : 30_000;
    return { ...base, deadlineMs: deadlineMs === undefined ? "unreadable" : deadlineMs + 1_000 };
  }

  /**
   * A skip condition that holds in every PR's e2e job: an opt-in variable only its own run sets
   * (`RUN_*`, `E2E_REAL_MODELS`, or a const holding one), or a worker that is not local.
   */
  function skipsOnPrs(condition: ts.Node, scope: Scope): boolean {
    const text = condition.getText();
    if (text === "!projectHostsAreLocal()") return true;
    if (/process\.env\.(RUN_[A-Z_]+|E2E_REAL_MODELS)\b/u.test(text)) return true;
    if (ts.isParenthesizedExpression(condition)) return skipsOnPrs(condition.expression, scope);
    if (ts.isPrefixUnaryExpression(condition)) return skipsOnPrs(condition.operand, scope);
    if (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )
      return skipsOnPrs(condition.left, scope) || skipsOnPrs(condition.right, scope);
    const initializer = ts.isIdentifier(condition) && scope.locals.get(condition.text);
    return !!initializer && skipsOnPrs(initializer, scope);
  }

  /** Where an identifier is imported from: a package's name, or a relative module's file. */
  function importOf(name: string, scope: Scope) {
    for (const statement of scope.source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const binding = bindings.elements.find((element) => element.name.text === name);
      if (!binding) continue;
      const module = statement.moduleSpecifier.text;
      const imported = (binding.propertyName || binding.name).text;
      return {
        module,
        name: imported,
        file: module.startsWith(".") ? resolve(dirname(scope.file), module) : undefined,
      };
    }
    return undefined;
  }

  /** A numeric constant expression: literals, arithmetic, and consts local or imported. */
  function evaluate(expression: ts.Expression, scope: Scope): number | undefined {
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isParenthesizedExpression(expression)) return evaluate(expression.expression, scope);
    if (ts.isBinaryExpression(expression)) {
      const left = evaluate(expression.left, scope);
      const right = evaluate(expression.right, scope);
      if (left === undefined || right === undefined) return undefined;
      switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return left + right;
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return left / right;
      }
      return undefined;
    }
    if (!ts.isIdentifier(expression)) return undefined;
    const local = scope.locals.get(expression.text);
    if (local) return evaluate(local, scope);
    const imported = importOf(expression.text, scope);
    if (!imported?.file || !existsSync(imported.file)) return undefined;
    const exported = scopeOf(imported.file);
    const initializer = exported.locals.get(imported.name);
    return initializer ? evaluate(initializer, exported) : undefined;
  }

  /**
   * The milliseconds of a fixed wait: `sleep(ms)`, `delay(ms)` or `setTimeout(fn, ms)`. A timer
   * that rejects is a deadline raced against the work, not a wait, and is not counted.
   */
  function fixedWaitMs(call: ts.CallExpression, scope: Scope) {
    const callee = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : ts.isIdentifier(call.expression)
        ? call.expression.text
        : undefined;
    const [first, second] = call.arguments;
    if (callee === "sleep" || callee === "delay") return first && evaluate(first, scope);
    if (callee !== "setTimeout" || !second || /\breject\b/u.test(first?.getText() ?? ""))
      return undefined;
    return evaluate(second, scope);
  }
}

/** The e2e project's options in apps/os/vitest.config.ts, as source text. */
function e2eProjectOptions() {
  const file = join(osRoot, "vitest.config.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let options: Record<string, string> | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const name = property(node, "name");
      if (name && ts.isStringLiteral(name) && name.text === "e2e")
        options = Object.fromEntries(
          node.properties.flatMap((entry) =>
            ts.isPropertyAssignment(entry)
              ? [[entry.name.getText(), entry.initializer.getText()]]
              : [],
          ),
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!options) throw new Error("apps/os/vitest.config.ts has no project named e2e");
  return options;
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  for (const entry of object.properties)
    if (ts.isPropertyAssignment(entry) && entry.name.getText() === name) return entry.initializer;
  return undefined;
}

function isFunction(node: ts.Node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function at(scope: Scope, node: ts.Node) {
  const { line } = scope.source.getLineAndCharacterOfPosition(node.getStart());
  return `${relative(repoRoot, scope.file)}:${line + 1}`;
}

function tsFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsFilesBelow(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
