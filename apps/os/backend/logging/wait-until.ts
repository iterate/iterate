import { logger } from "./logger.ts";
import type { WideLog } from "./types.ts";

type WaitUntilTask<T> = Promise<T> | (() => Promise<T>);
type WaitUntilOptions = {
  onError?: (log: WideLog) => void | Promise<void>;
};

function resolveTask<T>(task: WaitUntilTask<T>): Promise<T> {
  if (typeof task === "function") return Promise.resolve().then(task);
  return task;
}

export function wrapWaitUntilWithLogging<T>(
  task: WaitUntilTask<T>,
  options?: WaitUntilOptions,
): Promise<T> {
  let parent: ReturnType<typeof logger.get>;

  try {
    parent = logger.get();
  } catch {
    return resolveTask(task);
  }

  const parentRequest =
    typeof parent.request === "object" && parent.request !== null
      ? (parent.request as Record<string, unknown>)
      : {};
  const parentRequestId =
    typeof parentRequest.id === "string" ? parentRequest.id : `req_${crypto.randomUUID()}`;
  const requestId = `${parentRequestId}:waitUntil:${crypto.randomUUID()}`;
  const method = typeof parentRequest.method === "string" ? parentRequest.method : "WAITUNTIL";
  const path = `${typeof parentRequest.path === "string" ? parentRequest.path : "unknown"}#waitUntil`;

  return logger.run(async () => {
    logger.set({
      ...(typeof parent.service === "string" ? { service: parent.service } : {}),
      ...(typeof parent.environment === "string" ? { environment: parent.environment } : {}),
      request: {
        id: requestId,
        method,
        path,
        status: 500,
        waitUntil: true,
        parentRequestId,
      },
      ...(parent.egress ? { egress: parent.egress } : {}),
      ...(parent.user ? { user: parent.user } : {}),
    });

    try {
      const result = await resolveTask(task);
      logger.set({ request: { status: 200 } });
      return result;
    } catch (error) {
      logger.error(error, { request: { parentRequestId, waitUntil: true } });
      await options?.onError?.(logger.get());
      throw error;
    }
  });
}
