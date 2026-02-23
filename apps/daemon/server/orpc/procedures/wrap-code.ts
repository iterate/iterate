import ts from "typescript";

export interface WrapOptions {
  contextKeys: string[];
  /** Type annotation for the destructured params. Default: `"any"` */
  contextType?: string;
}

/**
 * If the code already contains `export default`, return it as-is.
 * Otherwise, wrap it in an `export default async (...)` function,
 * injecting destructured params for any execution-context keys
 * that appear as free (undeclared) identifiers in the code.
 */
export function wrapCodeWithExportDefault(code: string, options: WrapOptions): string {
  const sf = ts.createSourceFile("__check.ts", code, ts.ScriptTarget.ESNext, true);
  if (hasExportDefault(sf)) return code;

  const { contextKeys, contextType = "any" } = options;
  const usedContextKeys = findUsedContextKeys(sf, contextKeys);
  const params =
    usedContextKeys.length > 0 ? `{${usedContextKeys.join(", ")}}: ${contextType}` : "";

  if (isSingleExpression(code)) {
    return `export default async (${params}) => ${code}`;
  }

  const indented = code
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
  return `export default async (${params}) => {\n${indented}\n}`;
}

/** Check whether the code has a real `export default` declaration (not just the text inside a string/comment). */
function hasExportDefault(sf: ts.SourceFile): boolean {
  return sf.statements.some(
    (s) =>
      ts.isExportAssignment(s) ||
      (ts.canHaveModifiers(s) &&
        ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)),
  );
}

/**
 * Determine whether `code` is a single expression (no semicolons
 * separating statements, no `return`/`const`/`let`/`var`/`if`/etc.).
 *
 * We try to parse it as an arrow-function body expression using the
 * TypeScript compiler. If that succeeds it's a single expression.
 */
function isSingleExpression(code: string): boolean {
  // Quick disqualifiers: statement keywords at the start of a line
  if (
    /(?:^|[\n;])\s*(?:return|const|let|var|if|for|while|switch|throw|try|class|function)\b/.test(
      code,
    )
  ) {
    return false;
  }

  // Try to parse `async () => <code>` as a valid expression.
  // If the compiler produces no diagnostics and consumes all the code, it's a single expression.
  const wrapper = `const __check = async () => ${code}`;
  const sf = ts.createSourceFile("__check.ts", wrapper, ts.ScriptTarget.ESNext, true);
  // Should have exactly one statement (the VariableStatement) and no error tokens.
  if (sf.statements.length !== 1) return false;
  const stmt = sf.statements[0];
  if (!ts.isVariableStatement(stmt)) return false;
  const decl = stmt.declarationList.declarations[0];
  if (!decl?.initializer || !ts.isArrowFunction(decl.initializer)) return false;
  // The arrow body should NOT be a block — that would mean the parser
  // needed braces, so our expression parse succeeded only trivially.
  if (ts.isBlock(decl.initializer.body)) return false;

  // Make sure there are no parse diagnostics
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) return false;

  return true;
}

/**
 * Parse the code, collect all Identifier nodes, subtract locally-declared
 * names and well-known globals, then intersect with `contextKeys`.
 */
function findUsedContextKeys(sf: ts.SourceFile, contextKeys: string[]): string[] {
  if (contextKeys.length === 0) return [];

  const contextKeySet = new Set(contextKeys);

  const declared = new Set<string>();
  const referenced = new Set<string>();

  // Collect declarations and references via a simple AST walk.
  function visit(node: ts.Node, scope: Set<string>) {
    // --- declarations ---
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      scope.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      scope.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) {
      scope.add(node.name.text);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      scope.add(node.name.text);
    }
    // Destructuring in variable declarations
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      scope.add(node.name.text);
    }
    // import Foo / import { Foo }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name) scope.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              scope.add(el.name.text);
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            scope.add(clause.namedBindings.name.text);
          }
        }
      }
    }
    // for-of / for-in initializer: `for (const x of ...)` already
    // covered by isVariableDeclaration above.

    // Catch clause variable: `catch (e) { ... }`
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name)
    ) {
      scope.add(node.variableDeclaration.name.text);
    }

    // --- references ---
    if (ts.isIdentifier(node)) {
      // Skip identifiers that are property-access names (x.foo — `foo` is not a free ref)
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        // This is the `.foo` part of `x.foo` — skip
      } else if (parent && ts.isPropertyAssignment(parent) && parent.name === node) {
        // This is the key in `{ foo: ... }` — skip
      } else if (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
        // Shorthand `{ foo }` — the identifier IS a reference
        referenced.add(node.text);
      } else {
        referenced.add(node.text);
      }
    }

    ts.forEachChild(node, (child) => visit(child, scope));
  }

  ts.forEachChild(sf, (child) => visit(child, declared));

  // Identifiers that are referenced but not locally declared,
  // AND exist in the execution context.
  const used: string[] = [];
  for (const key of contextKeys) {
    if (referenced.has(key) && !declared.has(key) && contextKeySet.has(key)) {
      used.push(key);
    }
  }
  return used;
}
