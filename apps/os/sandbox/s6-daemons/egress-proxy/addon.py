"""
mitmproxy addon for egress proxy.

Routes ALL HTTP/HTTPS requests through the iterate OS worker endpoint.
WebSocket connections pass through transparently to their intended destination.

The worker handles:
- Token injection for specific hosts (OpenAI, Anthropic, etc.)
- Security controls and observability

Configuration:
- ITERATE_OS_BASE_URL: The iterate OS base URL (required, e.g. https://iterate.com)
- ITERATE_OS_API_KEY: API key for authenticating with the worker (required)
"""

import os
from urllib.parse import urlparse
from mitmproxy import http, ctx

# Configuration from environment
BASE_URL = os.environ.get("ITERATE_OS_BASE_URL", "")
API_KEY = os.environ.get("ITERATE_OS_API_KEY", "")

# Derive worker endpoint from base URL
WORKER_ENDPOINT = f"{BASE_URL.rstrip('/')}/api/egress-proxy" if BASE_URL else ""


class EgressProxyAddon:
    """
    Addon that forwards all HTTP/HTTPS requests through the worker endpoint.
    WebSocket connections pass through directly to their destination.
    
    Flow for HTTP/HTTPS:
    1. Client makes request to original URL
    2. mitmproxy intercepts
    3. We rewrite request to go to worker endpoint
    4. Worker handles token injection, forwards to actual destination
    5. Response flows back through mitmproxy to client
    
    Flow for WebSocket:
    1. Client makes WebSocket connection
    2. mitmproxy passes through directly (no rewriting)
    """
    
    def __init__(self):
        if not BASE_URL:
            ctx.log.warn("[egress] ITERATE_OS_BASE_URL not set - requests will pass through directly")
        if not API_KEY:
            ctx.log.warn("[egress] ITERATE_OS_API_KEY not set - worker auth will fail")
    
    def request(self, flow: http.HTTPFlow) -> None:
        """Handle HTTP/HTTPS requests - forward to worker."""
        # Skip WebSocket upgrade requests - let them pass through directly
        if flow.request.headers.get("Upgrade", "").lower() == "websocket":
            ctx.log.info(f"[egress] WebSocket passthrough: {flow.request.host}")
            return
        
        original_host = flow.request.host
        original_port = flow.request.port
        original_scheme = flow.request.scheme
        original_path = flow.request.path
        
        # Build original URL
        if (original_scheme == "https" and original_port == 443) or \
           (original_scheme == "http" and original_port == 80):
            original_url = f"{original_scheme}://{original_host}{original_path}"
        else:
            original_url = f"{original_scheme}://{original_host}:{original_port}{original_path}"
        
        ctx.log.info(f"[egress] {flow.request.method} {original_url}")
        
        # If no worker endpoint configured, let request pass through directly
        if not WORKER_ENDPOINT:
            return
        
        # Rewrite request to go through worker
        parsed = urlparse(WORKER_ENDPOINT)
        
        # Store original request info in custom headers for the worker
        flow.request.headers["X-Iterate-Original-URL"] = original_url
        flow.request.headers["X-Iterate-Original-Host"] = original_host
        flow.request.headers["X-Iterate-Original-Method"] = flow.request.method
        
        # Add API key for worker auth
        if API_KEY:
            flow.request.headers["X-Iterate-API-Key"] = API_KEY
        
        # Rewrite to worker endpoint
        flow.request.host = parsed.hostname
        flow.request.port = parsed.port or (443 if parsed.scheme == "https" else 80)
        flow.request.scheme = parsed.scheme
        flow.request.path = parsed.path or "/api/egress-proxy"
        
        # Update Host header
        if parsed.port and parsed.port not in (80, 443):
            flow.request.headers["Host"] = f"{parsed.hostname}:{parsed.port}"
        else:
            flow.request.headers["Host"] = parsed.hostname
    
    def response(self, flow: http.HTTPFlow) -> None:
        """Handle responses - mainly for logging."""
        original_url = flow.request.headers.get("X-Iterate-Original-URL", flow.request.url)
        ctx.log.info(f"[egress] Response {flow.response.status_code} for {original_url}")
    
    def websocket_start(self, flow: http.HTTPFlow) -> None:
        """Handle WebSocket connection start - just log, pass through."""
        ctx.log.info(f"[egress] WebSocket connection to {flow.request.host}")
    
    def websocket_message(self, flow: http.HTTPFlow) -> None:
        """Handle WebSocket messages - for logging/observability."""
        assert flow.websocket is not None
        message = flow.websocket.messages[-1]
        direction = "client->server" if message.from_client else "server->client"
        ctx.log.debug(f"[egress] WebSocket {direction}: {len(message.content)} bytes")
    
    def error(self, flow: http.HTTPFlow) -> None:
        """Handle errors."""
        ctx.log.error(f"[egress] Error for {flow.request.url}: {flow.error}")


addons = [EgressProxyAddon()]
