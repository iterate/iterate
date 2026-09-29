/**
 * Enough of the workflow expression language for the tests that evaluate a workflow's own
 * conditions and concurrency groups: `always()`, `cancelled()` (false: the runs they evaluate were
 * not cancelled), then quoted strings, ==, !=, !, &&, || and parentheses are JavaScript once each
 * context path is replaced by its value. A step's condition
 * without a status function is `success() && (...)`, true in those tests: the steps before the
 * ones they evaluate passed.
 */
export function evaluateWorkflowExpression(
  expression: string | undefined,
  context: Record<string, string>,
): unknown {
  const javascript = (expression || "true")
    .replaceAll("always()", "true")
    .replaceAll("cancelled()", "false")
    .replace(/[a-z_]+(?:\.[A-Za-z0-9_-]+)+/g, (path) => {
      if (!Object.hasOwn(context, path)) throw new Error(`${path} is not in the test's context`);
      return JSON.stringify(context[path]);
    });
  // oxlint-disable-next-line no-new-func -- evaluating the workflow's own expression IS the test
  return new Function(`return (${javascript});`)();
}

/** A string with `${{ … }}` placeholders, such as a concurrency group, as the runner renders it. */
export function renderWorkflowString(template: string, context: Record<string, string>): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) =>
    String(evaluateWorkflowExpression(expression, context)),
  );
}
