import { os } from "../base.ts";

export const testRouter = {
  test: {
    /**
     * Observability demo procedure.
     *
     * This intentionally emits several request-scoped log lines with pauses in
     * between so we can verify that evlog/request logging works over the full
     * lifecycle of a single oRPC call.
     */
    logDemo: os.test.logDemo.handler(async ({ context, input }) => {
      const steps = [
        "received-request",
        "starting-first-delay",
        "finished-first-delay",
        "starting-second-delay",
        "completed",
      ] as const;

      // Keep durable fields on the request logger itself so the shared evlog
      // middleware can emit one final wide event for the whole procedure.
      // https://www.evlog.dev/getting-started/introduction
      context.logger.set({
        logDemo: {
          label: input.label,
          steps,
        },
      });
      context.logger.info("example.test.log-demo.received");

      await new Promise((resolve) => setTimeout(resolve, 120));

      context.logger.info("example.test.log-demo.midpoint", {
        logDemo: { progress: "halfway" },
      });

      await new Promise((resolve) => setTimeout(resolve, 180));

      context.logger.info("example.test.log-demo.completed", {
        logDemo: { totalSteps: steps.length },
      });

      return {
        ok: true as const,
        label: input.label,
        requestId: context.requestId,
        steps: [...steps],
      };
    }),
    /**
     * Exception demo procedure.
     *
     * This throws a real server-side exception so we can later validate stack
     * traces, source maps, and server-side exception tracking.
     */
    serverThrow: os.test.serverThrow.handler(async ({ input }): Promise<never> => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error(input.message);
    }),
  },
};
