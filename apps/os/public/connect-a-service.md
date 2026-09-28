# Connect a service to an iterate project

You are a coding agent. You reach an iterate project through iterate's MCP server, and the person
asked you to connect a service to it ("connect Linear", "give my agents Exa"). This guide takes you,
and them, through it one step at a time. Each step says what to run, what to say to the person and
which step comes next. Do the steps in order and don't skip ahead.

When you finish, three things are true: the project holds the service's credential as a secret, one
read-only call has shown that it works, and the project's `AGENTS.md` says how to use it.

## How you run code in the project

iterate's MCP server has one tool, `run({ project?, script })`. `script` is the text of one
JavaScript function, `async (itx) => { … }`, and it runs at the project's root. Every code block
below is a `script`: send it as the `script` argument of `run`. Pass `project` (the project's slug,
for example `"connect-test"`) when the server reaches more than one project.

```js
async (itx) => ({ project: await itx.whoami() });
```

What comes back is what the function returns. Return plain data: strings, numbers, arrays and
objects. A handle, such as a connection, comes back as `{}`, so return what you read from it
instead. A thrown error comes back as its message.

## Four rules

1. **Never take a secret in the chat.** Don't ask for an API key, a client secret, a token or a
   password, and don't accept one. If the person pastes one anyway, tell them it is now exposed and
   should be revoked, and send them a collection link instead (step 3).
2. **Name a secret, never its value.** You can't read a secret, and you don't need to. Write
   `getSecret("/secrets/<name>")` where the value goes, in a header or a URL. The platform swaps the
   real value in on the way out, and only to the origins the secret is pinned to. It never looks at
   a request body.
3. **When the person has to do something, end your turn.** Say exactly what to do, then wait for
   them to reply "done". Don't poll, and don't guess what happened.
4. **Prove it before you say it's connected:** one read-only call that returns real data.

## Step 1. Look at the project

```js
async (itx) => ({
  project: await itx.whoami(),
  secrets: (await itx.secrets.list()).map((secret) => ({ path: secret.path, urls: secret.urls })),
});
```

Then go to the first line that fits:

- **The service is Slack, Google (Gmail, Calendar, Drive; not the Gemini API), Cloudflare or GitHub
  (as a GitHub App installation).** These are built in. Get the link that opens its Connect sheet:

  ```js
  async (itx) => itx.integrations.requestFromUser("slack");
  ```

  Send its `url`, then end your turn:

  > Slack is built into iterate. Open this link and press **Connect**:
  >
  > <url>
  >
  > Reply "done" when it's connected.

  When they reply "done", run step 1 again: the connection is a new secret,
  `/secrets/slack-<connection>`. Prove it as in step 4C, with
  `authorization: 'Bearer getSecret("/secrets/slack-<connection>", { field: "accessToken" })'` and
  a read-only call: Slack's `POST https://slack.com/api/auth.test`, or GitHub's
  `GET https://api.github.com/installation/repositories?per_page=1` (with a `user-agent` header).
  Then go to step 6.

  If the person wants their own OAuth app instead (for example a GitHub OAuth App that acts as
  them), carry on at step 2.

- **The service is Waitrose.** It's built in too: send
  https://dash.iterate.com/projects/<projectSlug>/integrations and ask them to press **Connect**
  next to Waitrose. `projectSlug` is in what step 1 returned: don't make up another link.

- **A secret for the service is already listed** (`/secrets/exa` for Exa, say): go to step 5.
- **Otherwise:** go to step 2.

## Step 2. Research the service, then pick a path

Search the service's own documentation: pages called "API keys", "Authentication", "MCP",
"OpenAPI" and "OAuth". Answer the questions in the table below in order, and stop researching at
the first "yes". Then write down only what that path needs, from the docs, never a guess. For Exa:

```
Service:            Exa
API keys page:      https://dashboard.exa.ai/api-keys
Hosted MCP server:  https://mcp.exa.ai/mcp, key in header x-api-key
OpenAPI document:   none
REST API origin:    https://api.exa.ai, key in header x-api-key
A read-only call:   the MCP tool web_search_exa, or POST https://api.exa.ai/search
OAuth:              no (if yes: does it register clients itself? step 4D, D0, says how to check)
```

Only a JSON OpenAPI 3 document counts: iterate doesn't read YAML or Swagger 2. An origin is scheme
and host only, `https://api.exa.ai`, with no path.

The first "yes" is your path:

| Question                                                                                      | Yes → path                  |
| --------------------------------------------------------------------------------------------- | --------------------------- |
| Runs a hosted MCP server that signs in with OAuth and registers clients itself?               | **D**: OAuth, step 4D       |
| Has no API keys at all, or the person asked for it to act as their own account through OAuth? | **D**: OAuth, step 4D       |
| Runs a hosted MCP server that takes the API key?                                              | **A**: key + MCP, step 4A   |
| Publishes a JSON OpenAPI 3 document?                                                          | **B**: key + OpenAPI, 4B    |
| Anything else with an API key                                                                 | **C**: key + HTTPS, step 4C |

Paths A, B and C start with step 3. Path D starts at step 4D.

## Step 3. Collect the key (paths A, B and C)

**3a.** Make the collection link. `path` is `/secrets/` plus the service's name in lowercase.
`urls` lists every origin you will send the key to: the MCP server's and the REST API's, when they
differ.

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/exa",
    egress: { urls: ["https://mcp.exa.ai", "https://api.exa.ai"] },
    description:
      "Your Exa API key, from https://dashboard.exa.ai/api-keys. It is only ever sent to Exa.",
  });
```

It returns `{ path, url }`.

**3b.** Send the person this message, with the real link and the real API keys page. Put the link
on a line of its own, exactly as returned: no backticks, no link text.

> Open this link, paste your Exa API key into **Value** and press **Set secret** (**Update
> secret** if it replaces one):
>
> <url>
>
> You can create a key at https://dashboard.exa.ai/api-keys. Reply "done" when it's saved, and
> please don't paste the key here.

**3c.** End your turn.

**3d.** When the person replies "done", check that the secret is there:

```js
async (itx) =>
  (await itx.secrets.list()).find((secret) => secret.path === "/secrets/exa") ?? "not saved yet";
```

- `"not saved yet"`: send the same link again (3b), and end your turn.
- It's there: go to 4A, 4B or 4C, whichever step 2 chose.

## Step 4A. A hosted MCP server

Connect, list the tools, and call one read-only tool:

```js
async (itx) => {
  const mcp = await itx.connectToMcp("https://mcp.exa.ai/mcp", {
    headers: { "x-api-key": 'getSecret("/secrets/exa")' },
  });
  // each tool's name and the arguments it takes
  const tools = (await mcp.listTools()).map((tool) => ({
    name: tool.name,
    args: Object.keys(tool.inputSchema?.properties ?? {}),
  }));
  const result = await mcp.callTool("web_search_exa", { query: "iterate", numResults: 1 });
  await mcp.close();
  return { tools, result };
};
```

Use the header the service documents. Many want
`authorization: 'Bearer getSecret("/secrets/<name>")'` instead of `x-api-key`. If you don't know a
tool's name yet, run the script with only `listTools()` first, then pick a tool that searches,
lists or reads.

It returned real data: go to step 6. It didn't: see "When something goes wrong".

## Step 4B. An OpenAPI document

Connect, list the operations, and call one GET operation that lists or reads something. Each
`operationId` is a method of the connection:

```js
async (itx) => {
  const api = await itx.connectToOpenApi(
    "https://generativelanguage.googleapis.com/$discovery/OPENAPI3_0?version=v1beta",
    { headers: { "x-goog-api-key": 'getSecret("/secrets/gemini")' } },
  );
  const reads = (await api.operations())
    .filter((operation) => operation.method.toUpperCase() === "GET")
    .map((operation) => `${operation.operationId} ${operation.path}`);
  return { reads: reads.slice(0, 40), proof: await api.ListModels({ pageSize: 3 }) };
};
```

- Path and query parameters go in the one input object: `api.GetModel({ model: "gemini-2.5-flash" })`.
- **The document lives on another host than the API** (OpenAI's is on GitHub, for example): pass
  `baseUrl`, the API's base URL. The key then goes to the API only, never to the document's host:

  ```js
  const api = await itx.connectToOpenApi(
    "https://raw.githubusercontent.com/openai/openai-openapi/main/openapi.json",
    {
      baseUrl: "https://api.openai.com/v1",
      headers: { authorization: 'Bearer getSecret("/secrets/openai")' },
    },
  );
  ```

- An `operationId` that isn't a plain name (`list-models`, `models.list`) has no method: call it as
  `api.call("list-models", {})`.

It returned real data: go to step 6. The document won't load, or it isn't JSON OpenAPI 3: use 4C
instead, with the same secret.

## Step 4C. Plain HTTPS

Send the request through `itx.fetch`, with the placeholder where the key goes:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.openai.com/v1/models", {
      headers: { authorization: 'Bearer getSecret("/secrets/openai")' },
    }),
  );
  return { status: response.status, body: (await response.text()).slice(0, 1000) };
};
```

The key goes wherever the service documents it:

| The docs say                           | Write                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `Authorization: Bearer <key>`          | `authorization: 'Bearer getSecret("/secrets/<name>")'`                   |
| `Authorization: <key>` (no `Bearer`)   | `authorization: 'getSecret("/secrets/<name>")'`                          |
| `X-Api-Key: <key>` or any other header | `"x-api-key": 'getSecret("/secrets/<name>")'`                            |
| `?api_key=<key>` in the URL            | `https://api.example.com/v1/search?api_key=getSecret("/secrets/<name>")` |

A POST works the same way: the key in a header, the JSON in the body. GraphQL, for example:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: 'getSecret("/secrets/linear")',
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "{ viewer { id name } }" }),
    }),
  );
  return { status: response.status, body: await response.json() };
};
```

Status 200 with real data: go to step 6. Anything else: see "When something goes wrong".

## Step 4D. OAuth

The platform runs the OAuth flow. Its callback is on the platform, and you never see a client
secret or the tokens. You need an OAuth client first, and there are two ways to get one:

- **The service registers clients itself** (its metadata lists a `registration_endpoint`; most
  hosted MCP servers do): you register one in D1a. The person only approves access.
- **Otherwise** the person registers an OAuth app with the service (D1b), and saves its client
  secret through a link. Then they approve access.

**D0. Find the endpoints.** You need the authorization endpoint, the token endpoint, the scopes,
whether there is a `registration_endpoint`, and how the token endpoint wants the client secret: in
the form body (`client_secret_post`) or in a Basic header (`client_secret_basic`). Many services
publish them. Set `origin` to the MCP server's origin, or the service's auth origin:

```js
async (itx) => {
  const origin = "https://mcp.linear.app";
  const read = async (url) => {
    const response = await itx.fetch(new Request(url));
    return response.ok ? response.json() : null;
  };
  // an MCP server may name its authorization server here
  const resource = await read(`${origin}/.well-known/oauth-protected-resource`);
  const issuer = resource?.authorization_servers?.[0] ?? origin;
  const metadata =
    (await read(`${issuer}/.well-known/oauth-authorization-server`)) ??
    (await read(`${issuer}/.well-known/openid-configuration`));
  if (!metadata) return "no metadata: read the service's OAuth documentation";
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint:
      metadata.registration_endpoint ?? "none: the person registers an app (D1b)",
    clientAuth: metadata.token_endpoint_auth_methods_supported,
    scopes: metadata.scopes_supported,
  };
};
```

GitHub publishes none. Its values are in the D2 sample below.

**D1a. The service registers clients itself: register one.** No app and no client secret. Send
exactly this, with the `registration_endpoint` from D0:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://mcp.linear.app/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "iterate",
        redirect_uris: ["https://os.iterate.com/.secrets/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  return { status: response.status, clientId: (await response.json()).client_id };
};
```

Keep the `clientId` it returns, and go straight to D2: leave `clientSecret` out and pass
`clientAuth: "none"`. Nothing for the person to do yet.

**D1b. Otherwise: the person's app, and a link for its client secret.** First make the link,
pinned to the origin of the token endpoint:

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/github-client-secret",
    egress: { urls: ["https://github.com"] },
    description:
      "The client secret of your GitHub OAuth app. It is only ever sent to GitHub's token endpoint.",
  });
```

Then tell the person exactly what to do, with the service's real settings page. For GitHub:

> Let's register an OAuth app with GitHub:
>
> 1. Open https://github.com/settings/applications/new and fill in:
>    - **Application name**: `iterate <project>`
>    - **Homepage URL**: `<projectUrl from step 1>`
>    - **Authorization callback URL**: `https://os.iterate.com/.secrets/oauth/callback`
> 2. Press **Register application**, then **Generate a new client secret**.
> 3. Paste the client secret into **Value** here and press **Set secret**: `<url>`
>    Please don't paste it into this chat.
> 4. Reply with the app's **Client ID**: it isn't secret. Also tell me what it should be allowed to
>    do, for example "read my profile" or "read my repositories".

On a self-hosted iterate, the callback is `/.secrets/oauth/callback` on the origin this guide is
served from. End your turn.

**D2. The consent.** After D1b, when the person replies with the client ID, first check that the
client secret is saved (step 3d, with `/secrets/github-client-secret`). Then start the flow. With
the person's GitHub app:

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/github", {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    clientId: "Ov23li…", // what the person sent you
    clientSecret: 'getSecret("/secrets/github-client-secret")',
    clientAuth: "client_secret_post",
    scope: "read:user", // the least the person asked for
    // the token endpoint's origin, and every API origin the token will be sent to
    urls: ["https://github.com", "https://api.github.com"],
  });
```

With a client you registered in D1a, there is no client secret. For Linear's MCP server:

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/linear", {
    authorizationEndpoint: "https://mcp.linear.app/authorize",
    tokenEndpoint: "https://mcp.linear.app/token",
    clientId: "…", // what D1a returned
    clientAuth: "none",
    scope: "read",
    urls: ["https://mcp.linear.app"],
  });
```

It returns `{ authorizationUrl }`. Say, with the link on a line of its own:

> Open this link and approve access:
>
> <authorizationUrl>
>
> It comes back to iterate, and the page says whether it worked. Reply "done" when it says
> **Done**, or send me what it says instead.

End your turn. The link works for an hour. If the person comes back later, or the page says it
expired, run D2 again and send the new link.

- **The person's app has no client secret** (a public client, PKCE only): skip the collection
  link in D1b, leave `clientSecret` out, and pass `clientAuth: "none"`.
- **Extra authorize parameters** go in `extra`. Google wants `{ access_type: "offline", prompt:
"consent" }` before it issues a refresh token.

**D3. The proof.** The tokens are a JSON secret at the path you passed to `beginOAuth`. Send the
access token with `{ field: "accessToken" }`:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.github.com/user", {
      headers: {
        authorization: 'Bearer getSecret("/secrets/github", { field: "accessToken" })',
        accept: "application/vnd.github+json",
        "user-agent": "iterate",
      },
    }),
  );
  return { status: response.status, login: (await response.json()).login };
};
```

For an MCP server, the proof is step 4A with the token in the header:

```js
async (itx) => {
  const mcp = await itx.connectToMcp("https://mcp.linear.app/mcp", {
    headers: { authorization: 'Bearer getSecret("/secrets/linear", { field: "accessToken" })' },
  });
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  await mcp.close();
  return { tools };
};
```

Then call one read-only tool from `tools`, as in 4A.

A token that expires is refreshed by the platform when the service answers 401, as long as the
service issued a refresh token. Go to step 6.

## Step 5. The secret already exists

Run the proof for its path with the existing secret: 4A, 4B or 4C for a key, D3 for OAuth. If it
works, go to step 6. If the service answers 401 or 403, the stored value is wrong or expired:
collect it again at the same path (step 3), which replaces it.

## Step 6. Tell the person, and write it down for the project's agents

Only after the proof worked: record the connection in the project's config repo, so its agents
find it later. This keeps everything in `AGENTS.md` and replaces the service's line if there is
one:

```js
async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const current = (await repo.readFile("AGENTS.md")) ?? "# Agents\n";
  const line =
    '- Exa: MCP at https://mcp.exa.ai/mcp with header `x-api-key: getSecret("/secrets/exa")`.';
  const kept = current
    .trimEnd()
    .split("\n")
    .filter((old) => !old.startsWith("- Exa:"));
  return repo.commitFiles({
    message: "Record the Exa connection",
    changes: [{ path: "AGENTS.md", content: `${[...kept, line].join("\n")}\n` }],
  });
};
```

Then tell the person what is stored, where it may go, and what the proof showed:

> Exa is connected. The key is at `/secrets/exa`, and it is only ever sent to `mcp.exa.ai` and
> `api.exa.ai`. A test search returned results. I noted it in the project's `AGENTS.md`, which
> republishes the project's worker.

## A whole conversation, start to finish

Person: "Connect Exa to my iterate project "connect-test"."

1. You run step 1. No `/secrets/exa`, and Exa isn't built in.
2. You read Exa's docs and fill in the sheet (step 2). Exa has API keys and a hosted MCP server:
   path A.
3. You run 3a and send the 3b message with the link. **Your turn ends.**
4. Person: "done". You run 3d: the secret is there.
5. You run 4A. `web_search_exa` returns a result.
6. You run step 6's commit, and send its message. Done.

With OAuth (GitHub, as the person's own account):

1. Step 1, then step 2: the person asked for their own account, so path D.
2. D1: you make the client-secret link and send the app instructions. **Your turn ends.**
3. Person: "done, client ID Ov23li…, read my profile". You check the secret, run D2 and send the
   consent link. **Your turn ends.**
4. Person: "done". You run D3: status 200 and their login. Step 6. Done.

With an MCP server that registers clients itself (Linear):

1. Step 1, then step 2: Linear's MCP server signs in with OAuth, and D0 shows a
   `registration_endpoint`. Path D.
2. D1a registers a client. D2 starts the flow, and you send the consent link. **Your turn ends.**
3. Person: "done". D3 lists the tools and calls one that reads. Step 6. Done.

## When something goes wrong

| What you see                                                                          | What it means, and what to do                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Your MCP client won't call `run` ("requires approval")                                | Ask the person to approve iterate's `run` tool in their client. For the Codex CLI: `-c mcp_servers.iterate.tools.run.approval_mode="approve"`. |
| `no stored project secret for getSecret("/secrets/…")`                                | Nothing is saved at that path yet. Check the path, then send the collection link again (step 3b).                                              |
| `the secret /secrets/… is pinned to … — not sent to …`                                | The secret isn't pinned to the host you called. Collect it again at the same path, with that origin added to `urls`.                           |
| `connectToOpenApi: fetching … returned 502` for a document on another host            | The key was headed to the document's host. Pass `baseUrl` (step 4B).                                                                           |
| `… is not an OpenAPI 3 document`                                                      | It's YAML or Swagger 2. Use step 4C with the same secret.                                                                                      |
| The service answers 401 or 403                                                        | Check the header name and format against its docs (the table in 4C), and that the person created the right kind of key.                        |
| The OAuth callback page says `the token endpoint returned no access_token`            | The client secret or `clientAuth` is wrong, or the app's callback URL doesn't match exactly. Fix it and run D2 again.                          |
| `beginOAuth` refuses the client secret                                                | The client-secret secret must exist and be pinned to the token endpoint's origin (D1b).                                                        |
| `The operation timed out.`                                                            | Run the same script once more.                                                                                                                 |
| `The RPC receiver does not implement the method "…"`                                  | That name isn't there: check it against `listTools()` or `operations()`, and that you awaited the connection.                                  |
| The callback page says `This link is not one the platform issued, or it has expired.` | The consent link works for an hour. Run D2 again and send the new link.                                                                        |
| The person pasted a key into the chat                                                 | Tell them to revoke it and make a new one, then send the collection link.                                                                      |
