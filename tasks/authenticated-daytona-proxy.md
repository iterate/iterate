---
state: todo
priority: high
size: medium
tags:
  - security
  - proxy
  - sandbox
---

# Authenticated Daytona Proxy

Use our worker as an authenticated proxy to Daytona sandboxes so they're not exposed directly to the internet.

# Some claude deep research on the matter

# Daytona sandbox authentication: Header tokens exist, but browsers need a custom proxy

**Daytona provides preview URL tokens via the SDK, but they must be sent as HTTP headers—not embedded in URLs.** For browser-based access without custom headers, Daytona's recommended solution is deploying a **custom preview proxy** that handles authentication before forwarding requests. There is no native signed URL or time-limited deep link feature for preview URLs, though SSH access tokens do support expiration.

## The core mechanism: Preview URLs with token headers

Daytona exposes sandbox services through preview URLs following this schema:

```
https://{PORT}-{SANDBOX_ID}.proxy.daytona.works
```

Any HTTP service on **ports 3000–9999** can be exposed. The SDK's `get_preview_link()` method returns both the URL and an authentication token:

```python
# Python SDK
preview_info = sandbox.get_preview_link(3000)
print(f"URL: {preview_info.url}")      # https://3000-abc123.proxy.daytona.works
print(f"Token: {preview_info.token}")   # vg5c0ylmcimr8b_v1ne0u6mdnvit6gc0
```

For private sandboxes (the default), programmatic access requires the `x-daytona-preview-token` header:

```bash
curl -H "x-daytona-preview-token: vg5c0ylmcimr8b_v1ne0u6mdnvit6gc0" \
  https://3000-sandbox-123456.proxy.daytona.work
```

**This is your limitation**: browsers navigating to a URL cannot inject this header, meaning direct URL sharing for private sandboxes requires workarounds.

## What Daytona doesn't provide natively

Based on comprehensive documentation review, these features are **not available** in Daytona's current implementation:

- **Signed URLs with embedded tokens** (no query-string `?token=xyz` support)
- **Time-limited preview URL tokens** (preview tokens don't have documented expiration)
- **Browser-native authentication flows** (no cookie-based auth like Gitpod/Codespaces)
- **Deep links with embedded credentials**

The preview URL tokens appear to be long-lived and tied to sandbox lifetime, unlike SSH access tokens which default to **60-minute expiration**.

## The recommended solution: Custom preview proxy

Daytona's documentation explicitly addresses your use case through their **Customer Proxy** feature, available since v0.25. This allows you to deploy your own proxy that:

1. Receives browser requests with your custom authentication (OAuth, JWT, query params, cookies)
2. Validates credentials against your control plane
3. Fetches the Daytona preview token via the SDK
4. Forwards requests with the `X-Daytona-Preview-Token` header

Official sample implementations exist in both TypeScript and Go at `github.com/daytonaio/daytona-proxy-samples`.

| Proxy Header                           | Purpose                          |
| -------------------------------------- | -------------------------------- |
| `X-Daytona-Preview-Token: {token}`     | Authenticates to private sandbox |
| `X-Daytona-Skip-Preview-Warning: true` | Bypasses security warning page   |
| `X-Daytona-Disable-CORS: true`         | Overrides default CORS settings  |

This approach lets you implement exactly what you need: **URL-embedded tokens, time-limited links, or any custom authentication scheme** while keeping the underlying sandbox private.

## Architecture for your specific case

Given your setup (daemon with access token validation, control plane with tokens), here's the recommended architecture:

```
Browser → Your Proxy (custom.yourdomain.com)
              ↓ validates your access token (from URL query, cookie, or auth header)
              ↓ looks up Daytona preview token from control plane
              ↓ adds X-Daytona-Preview-Token header
         Daytona Proxy → Sandbox Daemon
```

Your proxy can accept tokens via URL query parameters (`?access_token=xyz`), enabling shareable links with **high-entropy, unpredictable URLs** that browsers can navigate directly. You control token expiration, validation logic, and URL structure.

## Alternative approaches with trade-offs

**Public sandbox with application-layer auth**: Set `public: true` when creating the sandbox, which removes Daytona's authentication requirement. Your daemon's existing token validation continues protecting the service. The preview URL becomes publicly routable but not publicly accessible without your token.

```python
sandbox = daytona.create(CreateSandboxParams(
    public=True,  # Daytona won't require authentication
))
```

Trade-off: The URL pattern is predictable (`{port}-{sandbox_id}.proxy.daytona.works`), and anyone who guesses or discovers a sandbox ID can attempt requests—though your daemon will reject unauthenticated ones.

**Organization-scoped access**: Private sandboxes are accessible to logged-in organization members without explicit tokens. If your users are Daytona organization members, they can access preview URLs directly after Daytona authentication.

Trade-off: Only works for users within your Daytona organization; not suitable for external sharing.

## Time-limited authentication does exist for SSH

While preview URLs lack native expiration, SSH access tokens do support custom time limits:

```python
ssh_access = sandbox.create_ssh_access(expires_in_minutes=30)
# ssh {ssh_access.token}@ssh.app.daytona.io
```

Tokens auto-expire and can be revoked programmatically. This could be relevant if your daemon supports SSH tunneling as an alternative access method.

## Conclusion: Build a thin proxy layer

Daytona's authentication model assumes programmatic clients that can set headers, not direct browser navigation. The **custom preview proxy** is the intended solution for your use case—it's documented, supported, and gives you complete control over URL structure and authentication logic.

For minimal implementation effort:

1. Deploy a lightweight proxy (the Go/TypeScript samples are ~200 lines)
2. Accept your existing access tokens via URL query parameter
3. Map tokens to Daytona preview tokens using your control plane
4. Forward authenticated requests with the `X-Daytona-Preview-Token` header

This gives you time-limited, high-entropy URLs for browser access while keeping sandboxes private at the Daytona infrastructure level.
