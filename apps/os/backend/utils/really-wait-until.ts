function logDebug(message: string): void {
  if (process.env.DEBUG?.toLowerCase() === "true" || process.env.NODE_ENV?.toLowerCase() === "1") {
    console.log(`[ReallyWaitUntil] ${message}`);
  }
}

function logError(message: string, err: unknown): void {
  console.error(`[ReallyWaitUntil] ${message}`, err);
}

/**
 * Actually wait until a promise resolves.
 * Cloudflare Durable Object runtime will kill in-flight promises within about 2 minutes (if not less) after the last network request.
 * 
 * This function will keep the Durable Object alive while your promise is still running by sending a no-op fetch to it every 10 seconds.
 * It calls OPTION on the Durable Object every 10 seconds to keep it awake.
 * 
 * @param promise - The promise to await
 * @returns A promise that resolves when the input promise resolves
 */
export function reallyWaitUntil(durableObject: DurableObject, promise: Promise<unknown>): void {
    const start = Date.now();

    const ctx = (durableObject as any).ctx;
    const exportsNs = ctx?.exports;
    if (!exportsNs) {
        throw new Error("No exports on DurableObject context. You must enable exports by adding the compatibility flag \"enable_ctx_exports\" (see https://developers.cloudflare.com/workers/configuration/compatibility-flags/).");
    }
    const className: string = (durableObject as any).constructor?.name ?? "";
    const durableObjectNamespace = exportsNs[className];
    if (!durableObjectNamespace) {
        throw new Error(`No exports namespace for DurableObject class ${className}`);
    }

    let count = 0;
    const intervalFinished = new Promise<void>((resolve) => {
        
        const interval = setInterval(async () => {
            count++;
            try {
                const isPromiseFinished = await Promise.race([await promise.finally(() => true), new Promise((resolve) => setTimeout(resolve, 1))]);
                if (isPromiseFinished) {
                    clearInterval(interval);
                    resolve();
                    return;
                }

                const response = await durableObjectNamespace
                    .get(ctx.id)
                    .fetch("http://self/reallyWaitUntil/stayAwakeNoOp", { method: "OPTIONS" });
                // consume the body so it's not left hanging but don't do anything with it
                await response.text();

                // Cloudflare sometimes gets funky with Date.now outside of a request context so we record the iteration count as well
                logDebug(`Background task has been running for ${Date.now() - start}ms (iteration ${count}), sending a no-op fetch to keep the agent awake`);
            } catch (err) {
                logError("Error keeping agent awake", err);
            }
        }, 10000);
    });

    // put promises on ctx.waitUntil because sometimes in local dev things that aren't awaited and aren't in a waitUntil don't get executed.
    ctx.waitUntil(promise);
    ctx.waitUntil(intervalFinished);
}