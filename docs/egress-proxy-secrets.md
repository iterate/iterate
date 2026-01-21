# Egress Proxy & Secret Injection

Sandboxes use a magic string pattern to access secrets without exposing them directly.

## Magic String

```
getIterateSecret({secretKey: "github.access_token"})
```

Place this in HTTP headers or the path. The egress proxy intercepts outbound requests and replaces the magic string with the actual secret value.

## How It Works

1. All sandbox HTTP traffic routes through mitmproxy → egress proxy
2. Egress proxy parses `getIterateSecret({secretKey: "..."})` from URL paths and headers (including base64-decoded Basic auth. It also supports urlencoding.
3. Looks up secret by key + project/org/user context + allowlisted url patterns.
4. Replaces magic string with real secret value before forwarding request

## Git Authentication

Git auth uses URL rewriting via git config (set in `apps/os/sandbox/entry.sh`):

```bash
GITHUB_MAGIC_TOKEN='getIterateSecret%28%7BsecretKey%3A%20%22github.access_token%22%7D%29'
git config --global --add "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "https://github.com/"
git config --global --add "url.https://x-access-token:${GITHUB_MAGIC_TOKEN}@github.com/.insteadOf" "git@github.com:"
```

Note: Magic string is URL-encoded in git config; egress proxy decodes before processing.

## Secret Scopes

- **Project-scoped**: `userId` is NULL, matched by `projectId` + `organizationId`
- **User-scoped**: requires explicit `userId` in magic string, also requires matching `projectId`
