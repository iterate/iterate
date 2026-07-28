// The concrete calls a source stream can make to subscription receivers.
// Callback retention is separate in retained-event-callbacks.ts.

import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";
import { StreamReceiverUnavailableError } from "iterate/processors";
import type {
  StreamDeliveryBatch,
  StreamProcessorWakeRequest,
  CopyReceipt,
  StreamWebhookDelivery,
} from "iterate/processors";
import { evaluateItxExpression, type ItxExpression } from "../../itx/expression.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import type { ExpectedHostedDeliveryState } from "./stream-connections.ts";
import type { SubscriptionReceiverCalls } from "./stream-event-sender.ts";
import { retainProcessorWakeResponse } from "./retained-event-callbacks.ts";

const WORKERS_HUNG_ENTRYPOINT_MESSAGE =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.";

function isWorkersHungEntrypointError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "Error" &&
    error.message.startsWith(WORKERS_HUNG_ENTRYPOINT_MESSAGE)
  );
}

/** Convert a canceled project-worker call into the receiver-availability error contract. */
function rethrowItxDeliveryError(error: unknown): never {
  if (isWorkersHungEntrypointError(error)) {
    throw new StreamReceiverUnavailableError(
      `project worker receiver was canceled before acknowledgement: ${error.message}`,
      { cause: error },
    );
  }
  throw error;
}

/** Build the four concrete calls used by the receiver union. */
export function createSubscriptionReceiverCalls(deps: {
  projectId: string | null;
  exports: unknown;
  createAuthorityRoot(): unknown;
  copyToStream(path: string, batch: StreamDeliveryBatch): Promise<CopyReceipt>;
  onHostedDeliveryError(
    subscriptionKey: string,
    error: unknown,
    expectedDelivery: ExpectedHostedDeliveryState,
  ): void;
}): SubscriptionReceiverCalls {
  let webhookEgress: ReturnType<typeof projectEgressFetcher> | undefined;

  const evaluateItxDelivery = async (expression: ItxExpression, batch: StreamDeliveryBatch) => {
    let value: unknown;
    try {
      ({ value } = await evaluateItxExpression(
        deps.createAuthorityRoot(),
        toInvocation(expression, batch),
      ));
    } catch (error) {
      rethrowItxDeliveryError(error);
    }
    try {
      disposeIgnoredRpcResult(value);
    } catch (error) {
      // The completed call is the acknowledgement. Cleanup failure is visible,
      // but must not retry and send the same batch twice.
      console.warn("ITX stream delivery result dispose failed after acknowledgement", { error });
    }
  };

  return {
    async wakeStreamProcessor(
      expression: ItxExpression,
      request: StreamProcessorWakeRequest,
      expectedDelivery: ExpectedHostedDeliveryState,
    ) {
      const { value } = await evaluateItxExpression(
        deps.createAuthorityRoot(),
        toInvocation(expression, request),
      );
      return retainProcessorWakeResponse({
        value,
        onDeliveryError: (error) =>
          deps.onHostedDeliveryError(request.subscriptionKey, error, expectedDelivery),
      });
    },

    async deliverToItx(expression: ItxExpression, batch: StreamDeliveryBatch) {
      await evaluateItxDelivery(expression, batch);
    },

    async copyToStream(path: string, batch: StreamDeliveryBatch) {
      return deps.copyToStream(path, batch);
    },

    async deliverToWebhook(url: string, delivery: StreamWebhookDelivery) {
      if (deps.projectId === null) {
        throw new Error("webhook subscriptions require a project-scoped stream");
      }
      webhookEgress ??= projectEgressFetcher(
        deps.exports as ExecutionContext["exports"],
        deps.projectId,
        { kind: "scope", scopePath: "/" },
      );
      const egress = webhookEgress;
      try {
        const response = await egress.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(delivery),
        });
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`webhook responded ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        if (webhookEgress === egress) webhookEgress = undefined;
        (egress as Partial<Disposable>)[Symbol.dispose]?.();
        throw error;
      }
    },
  };
}

/** Turn the final property step into a receiver-bound method call. */
function toInvocation(expression: ItxExpression, payload: unknown): ItxExpression {
  const methodName = expression.at(-1);
  if (typeof methodName !== "string") {
    throw new Error("delivery expression must end in a property step naming the method to invoke");
  }
  return [...expression.slice(0, -1), [methodName, payload]];
}
