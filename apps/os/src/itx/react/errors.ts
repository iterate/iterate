// capnweb flattens kernel throws to bare message strings (no codes — the
// structured ItxError is still on the plan), so until that lands, access
// failures are recognised by message shape. The kernel deliberately answers
// missing AND forbidden with the same "not found" wording (no existence
// probing), which is exactly the class of error retrying can never fix.

const ACCESS_ERROR_PATTERN = /\b(not found|not accessible|forbidden|unauthorized|admin access)\b/i;

/** True when retrying cannot help: authorization/existence failures. */
export function isItxAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ACCESS_ERROR_PATTERN.test(message);
}
