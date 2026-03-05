# Secrets management

## How agents access secrets

Provide a header of the format:

`getIterateSecret({secretKey: "gmail.access-token": machineId: "mach_", userId: "user_123"})`

This information will be added to a system prompt / skill etc. This will match 1:1 to an ORPC procedure, so it's a real function in our codebase. By default it will add this to the Authorization header.

"Authorization: Bearer ${getIterateSecret({})}"

DECISION: Wherever we find the string in Header or Path, we will replace it.

## 1. Authentication

Is the HTTP client based on its credentials (single access token) allowed to see the secret that it wants to substitute. Right now this is entirely based on having an access token that is connected to the project that the secret belongs to. There is no user level AUTH!

## 2. Egress proxy rules

Given the secret contained in the request, and the request destination and the configuration of the project etc, is this request allowed to proceed.

Use secret- [or project-level] JSONATA expression

`https://api.openai.com/*, https://openai.com/api/*`

JSON rule engine

- `url.href = https://api.openai.com/* or url.href= https://openai.com/api/*` or `url.hostname == 'https://api.openai.com' || url.hostname == 'https://someproxy.com'` or something

## Secret Heirarchy

In order of specificity. Global > Org > Project > User (within project). A more specific key can overwrite a less specific one.

## How agents manage and use secrets

### 'Hardcoded' secrets

We will provide a list of built-in secret keys that the agent can use directly. E.G. Claude, OpenAI, Gemini, Replicate, Exa. These will still be limited to a particular URL pattern, but this pattern will be managed by the OS.

If a user overwrites this secret key, then it will use _their_ value rather than ours (e.g. BYO OpenAI API key).

Suggestion: Add this list directly to the skill.

Skill says:

- Check out ~/.iterate/.env for env vars in this project -> this also contains helpful comment explaining about this system

.env

```
OPENAI_API_KEY=getSecret({ key: "openai_key" })
BOB_GMAIL_ACCESS_TOKEN=getSecret({ key: "gmail.accesstoken", userId: "" }) <-- not including this, but add comment explaining to AI how to use
SOMETHING_NOT_SECRET=bananas
```

### How does proxy know which agent is asking

- User agent header

# In scope oauth

- I connect my gmail in a project
- Bob connects his gmail in a project

Any agent can now use EITHER of our connections with precision

Oauth flow happens in os app - the error just says "Go to os.iterate.com/org/.../projs/proj\_.../connections"

Automated token refresh

# Procedure and data model

connection table

- existing oauth clients
- mapping to secret table

secrets table (new)

- org (optional)
- project (optional)
- user_id (optional)
- identifier (has to be unique within (org, project, user_id))
- encrypted value (optional)
- metadata json blob (optional)
- timestamps
- egress_proxy_rule (optional)

if neither org, project, user are set, then it's a global key
GLOBAL env vars are bootstrapped from our environment variables, but stored encrypted
Once alchemy finishes, update the database with the secrets

env table no encrypted columns at all (change)

- project + SOME_ENV_VAR_NAME -> getIterateSecret() string or non-secret env var
- this ends up very transparently in .env

orpc procedure args (id, machineId, userId) + implicit project id (via access token header) + implicit agent path (via user agent)

# Out of scope for now

Human in the loop
MCP dynamic clients

### On demand secrets (out of scope)

Sometimes secrets can be on-demand - e.g. an OAuth flow for a MCP server. In the case that

- The server advertises OAuth or Bearer support somehow (like via MCP, or a well known OAuth client like Gmail)
- There are no existing, valid secrets for that user

the proxy will return an error explaining to the agent that credentials need to be fetched, with a URL to collect the credentials from the user. The agent is expected to display this URL to the user (e.g. via a Slack button), and retry the request after it is complete. This agent will receive a webhook after this flow completes.

The egress proxy will manage rotation of OAuth credentials. If an auth error is received by the proxy, it will clear its credentials.

For discussion: Do we still want to keep the concept of per_project, user specific tokens - in this case how does the proxy know whether to store a new token as per_project or user specific? Can the agent influence this somehow?

### Human in the loop (out of scope)

The egress proxy will return an error to the agent indicating that human in the loop approval is required. The egress proxy will store the request, including body, headers, url, and trigger an out-of-band human validation request.

The agent will receive a webhook after approval is granted or denied.

For discussion: Some requests are invalid after a short period of time (e.g. short lived tokens). Do we get the agent to retry the request, or do we send the request as part of the approval flow? Gut feel is to get the agent to retry it.

### Discovery of secrets (out of scope)

We will provide a tool/endpoint that the agent can call to get all secret keys for a given user / url that it can use.

If an agent tries to use a secret that is invalid, the proxy will return an error message which includes all the available keys for that user / url pattern.

e.g.

`Secret 'google.token' is invalid. Available secrets for api.google.com - gmail.token, youtube.token`.

### Non secret env vars

Sometimes a user wants to add env vars that are not secret (e.g. current app stage)

The UI should provide some way to specify this, and these should be passed into the sandbox environment variables as-is.
