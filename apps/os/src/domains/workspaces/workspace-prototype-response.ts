/** Keep read transport failures from escaping as a partial successful HTTP response. */
export async function prototypeWorkspaceResponse(
  request: Request,
  dispatch: () => Promise<Response>,
): Promise<Response> {
  const materialize = async () => {
    const response = await dispatch();
    // A disconnected RPC body must fail before HTTP success headers leave the proxy.
    return new Response(response.body === null ? null : await response.arrayBuffer(), response);
  };
  const failed = (error: unknown) => {
    console.error("workspace prototype transport failed", {
      method: request.method,
      path: new URL(request.url).pathname,
      error,
    });
    return new Response("Workspace transport failed", { status: retryable(error) ? 503 : 502 });
  };
  try {
    return await materialize();
  } catch (error) {
    if (request.method !== "GET" || !retryable(error)) return failed(error);
    console.warn("workspace prototype read retry", {
      path: new URL(request.url).pathname,
      attempt: 1,
      error,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      // dispatch obtains a fresh DO stub; a disconnected stub must never be reused.
      return await materialize();
    } catch (error) {
      return failed(error);
    }
  }
}

function retryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === true &&
    !("overloaded" in error && error.overloaded === true)
  );
}
