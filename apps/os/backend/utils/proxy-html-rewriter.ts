/**
 * HTML rewriter for proxied content.
 *
 * When serving web apps through our authenticated proxy, we need to rewrite
 * URLs so that:
 * - Static assets (src="/app.js") load through the proxy path
 * - Links (href="/page") navigate through the proxy path
 * - WebSocket/fetch calls in JavaScript get intercepted and rewritten
 *
 * This uses Cloudflare's HTMLRewriter for streaming transformation.
 */

/**
 * Rewrite HTML URLs to work through the proxy.
 *
 * Handles:
 * - <base href="/"> → <base href="${proxyBasePath}/">
 * - src="/path" → src="${proxyBasePath}/path"
 * - href="/path" → href="${proxyBasePath}/path"
 * - Injects script to intercept WebSocket/fetch URLs constructed in JavaScript
 */
export function rewriteHTMLUrls(response: Response, proxyBasePath: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  class URLRewriter implements HTMLRewriterElementContentHandlers {
    constructor(private attr: string) {}
    element(element: Element) {
      const value = element.getAttribute(this.attr);
      if (value?.startsWith("/") && !value.startsWith("//")) {
        element.setAttribute(this.attr, `${proxyBasePath}${value}`);
      }
    }
  }

  class BaseRewriter implements HTMLRewriterElementContentHandlers {
    element(element: Element) {
      const href = element.getAttribute("href");
      if (href === "/") {
        element.setAttribute("href", `${proxyBasePath}/`);
      }
    }
  }

  // Inject a script to intercept WebSocket and fetch calls.
  // This handles JavaScript-constructed URLs that can't be rewritten via HTML attributes.
  class HeadInjector implements HTMLRewriterElementContentHandlers {
    element(element: Element) {
      const script = `<script>
(function() {
  var proxyBase = ${JSON.stringify(proxyBasePath)};
  var currentHost = location.host;

  // Intercept WebSocket construction
  var OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var rewritten = rewriteUrl(url, 'ws');
    return protocols !== undefined
      ? new OriginalWebSocket(rewritten, protocols)
      : new OriginalWebSocket(rewritten);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // Intercept fetch calls
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = rewriteUrl(input, 'http');
    } else if (input instanceof Request) {
      var rewrittenUrl = rewriteUrl(input.url, 'http');
      if (rewrittenUrl !== input.url) {
        input = new Request(rewrittenUrl, input);
      }
    }
    return originalFetch.call(this, input, init);
  };

  function rewriteUrl(url, scheme) {
    try {
      var parsed = new URL(url, location.href);
      // Only rewrite URLs pointing to the current host
      if (parsed.host !== currentHost) return url;
      // Don't rewrite if already under proxy path
      if (parsed.pathname.startsWith(proxyBase)) return url;
      // Rewrite the path
      parsed.pathname = proxyBase + parsed.pathname;
      return parsed.toString();
    } catch (e) {
      return url;
    }
  }
})();
</script>`;
      element.prepend(script, { html: true });
    }
  }

  return new HTMLRewriter()
    .on("head", new HeadInjector())
    .on("base", new BaseRewriter())
    .on("[src]", new URLRewriter("src"))
    .on("[href]:not(base)", new URLRewriter("href"))
    .transform(response);
}
