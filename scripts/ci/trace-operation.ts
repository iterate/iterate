import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Measured work inside a CI step. Parallel operations keep their own parent. */
export async function traceOperation<T>(
  name: string,
  operation: (span: { fail(): void }) => Promise<T>,
) {
  const enabled = process.env.CI_TRACE_ENABLED === "1";
  const id = randomUUID();
  let status = "passed";
  if (enabled)
    console.log(
      `@@ci-trace ${JSON.stringify({
        kind: "span-start",
        id,
        parentId: parent.getStore() || "",
        name,
        time: Date.now(),
      })}`,
    );
  try {
    return await parent.run(id, () =>
      operation({
        fail() {
          status = "failed";
        },
      }),
    );
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    // Names, status and times only: never copy exception payloads into public reports.
    if (enabled)
      console.log(
        `@@ci-trace ${JSON.stringify({ kind: "span-end", id, status, time: Date.now() })}`,
      );
  }
}

const parent = new AsyncLocalStorage<string>();
