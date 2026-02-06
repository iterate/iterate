# Egress Proxy & Secret Injection

Sandboxes use a magic string pattern to access secrets without exposing them directly.

## Magic String

```
getIterateSecret({secretKey: "github.access_token"})
getIterateSecret({secretKey: 'anthropic_api_key'})   # single quotes also work
getIterateSecret%28%7BsecretKey%3A%20%27openai_api_key%27%7D%29 # urlencoding also works
```

Place this in HTTP headers or the path. The egress proxy intercepts outbound requests and replaces the magic string with the actual secret value. If in the path, it should be urlencoded.

**Quote style**: Use single quotes (`'`) or urlencoding when the magic string will be embedded in JSON (e.g., env vars used in JSON config files). Double quotes break JSON parsing.

## How It Works

1. All sandbox HTTP traffic routes through mitmproxy → egress proxy
2. Egress proxy parses `getIterateSecret({secretKey: "..."})` from URL paths and headers (including base64-decoded Basic auth. It also supports urlencoding.
3. Looks up secret by key + project/org/user context + allowlisted url patterns.
4. Replaces magic string with real secret value before forwarding request

## Git Authentication

Git auth uses a credential helper that returns the magic string (set in `apps/os/sandbox/pidnap.config.ts`):

```bash
# ~/.git-credential-helper.sh
#!/bin/bash
echo "username=x-access-token"
echo "password=getIterateSecret({secretKey: 'github.access_token'})"

# ~/.gitconfig
[credential]
    helper = !~/.git-credential-helper.sh
[url "https://github.com/"]
    insteadOf = git@github.com:
```

The credential helper provides the magic string as the password. The egress proxy intercepts the request and replaces it with the real GitHub token.

**Why not URL credentials?** The old approach (`url.https://x-access-token:TOKEN@github.com/.insteadOf`) caused git to use a 401-challenge flow (two requests) that broke through the mitmproxy → egress proxy chain. The credential helper avoids this by providing credentials directly.

## Secret Scopes

- **Project-scoped**: `userId` is NULL, matched by `projectId` + `organizationId`
- **User-scoped**: requires explicit `userId` in magic string, also requires matching `projectId`
