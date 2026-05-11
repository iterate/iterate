/**
 * Code normalization: strips markdown fences and wraps user code in async arrow functions.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/normalize.ts
 */

import * as acorn from "acorn";

function stripCodeFences(code: string): string {
  const fenced = /^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/;
  const match = code.match(fenced);
  return match ? match[1]! : code;
}

export function normalizeCode(code: string): string {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed.trim()) return "async () => {}";

  const source = trimmed.trim();

  try {
    const ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    if (ast.body.length === 1 && ast.body[0]!.type === "ExpressionStatement") {
      const expr = (ast.body[0] as acorn.ExpressionStatement).expression;
      if (expr.type === "ArrowFunctionExpression") return source;
    }

    if (ast.body.length === 1 && ast.body[0]!.type === "ExportDefaultDeclaration") {
      const decl = (ast.body[0] as acorn.ExportDefaultDeclaration).declaration;
      const inner = source.slice(decl.start, decl.end);

      if (decl.type === "FunctionDeclaration" && !(decl as acorn.FunctionDeclaration).id) {
        return `async () => {\nreturn (${inner})();\n}`;
      }
      if (decl.type === "ClassDeclaration" && !(decl as acorn.ClassDeclaration).id) {
        return `async () => {\nreturn (${inner});\n}`;
      }

      return normalizeCode(inner);
    }

    if (ast.body.length === 1 && ast.body[0]!.type === "FunctionDeclaration") {
      const fn = ast.body[0] as acorn.FunctionDeclaration;
      const name = fn.id?.name ?? "fn";
      return `async () => {\n${source}\nreturn ${name}();\n}`;
    }

    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      const exprStmt = last as acorn.ExpressionStatement;
      const before = source.slice(0, last.start);
      const exprText = source.slice(exprStmt.expression.start, exprStmt.expression.end);
      return `async () => {\n${before}return (${exprText})\n}`;
    }

    return `async () => {\n${source}\n}`;
  } catch {
    return `async () => {\n${source}\n}`;
  }
}
