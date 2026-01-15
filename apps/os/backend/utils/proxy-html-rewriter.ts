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
 * Modify CSP header to allow our inline script.
 * Adds 'unsafe-inline' to script-src if CSP exists.
 */
function relaxCSPForInlineScript(headers: Headers): Headers {
  const csp = headers.get("content-security-policy");
  if (!csp) return headers;

  // Modify script-src to allow inline scripts
  const newCSP = csp.replace(/script-src\s+([^;]*)/i, (match, sources) => {
    // Add 'unsafe-inline' if not already present
    if (!sources.includes("'unsafe-inline'")) {
      return `script-src ${sources} 'unsafe-inline'`;
    }
    return match;
  });

  const newHeaders = new Headers(headers);
  newHeaders.set("content-security-policy", newCSP);
  return newHeaders;
}

/**
 * Rewrite HTML URLs to work through the proxy.
 *
 * Handles:
 * - <base href="/"> → <base href="${proxyBasePath}/">
 * - src="/path" → src="${proxyBasePath}/path"
 * - href="/path" → href="${proxyBasePath}/path"
 * - Injects script to intercept WebSocket/fetch URLs constructed in JavaScript
 * - Relaxes CSP to allow our injected inline script
 */
export function rewriteHTMLUrls(response: Response, proxyBasePath: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  // Relax CSP to allow our injected inline script
  const headers = relaxCSPForInlineScript(response.headers);

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

  // Create a new response with relaxed CSP headers
  const modifiedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  return new HTMLRewriter()
    .on("head", new HeadInjector())
    .on("base", new BaseRewriter())
    .on("[src]", new URLRewriter("src"))
    .on("[href]:not(base)", new URLRewriter("href"))
    .transform(modifiedResponse);
}

/**
 * Rewrite CSS URLs to work through the proxy.
 *
 * Handles url() references in CSS files that point to absolute paths like /assets/font.woff2
 */
export async function rewriteCSSUrls(response: Response, proxyBasePath: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/css")) {
    return response;
  }

  const css = await response.text();

  // Rewrite absolute URLs in url() references: url(/path) or url("/path") or url('/path')
  const rewrittenCSS = css.replace(
    /url\(\s*(["']?)\/(?!\/)(.*?)\1\s*\)/g,
    (match, quote, path) => `url(${quote}${proxyBasePath}/${path}${quote})`,
  );

  return new Response(rewrittenCSS, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
