const SHELL_PATH = "/_shell.html";

export default {
  async fetch(request, env) {
    const assetResponse = await env.ASSETS.fetch(request);

    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return assetResponse;
    }

    const accept = request.headers.get("accept") ?? "";
    const secFetchMode = request.headers.get("sec-fetch-mode") ?? "";
    const isDocumentRequest = secFetchMode === "navigate" || accept.includes("text/html");

    if (!isDocumentRequest) {
      return assetResponse;
    }

    const shellUrl = new URL(request.url);
    shellUrl.pathname = SHELL_PATH;
    shellUrl.search = "";

    return env.ASSETS.fetch(new Request(shellUrl, request));
  },
};
