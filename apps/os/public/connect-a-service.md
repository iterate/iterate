# Connect a service to an iterate project

A recipe for a coding agent that reaches an iterate project through iterate's MCP server. Follow it
when the person asks you to connect a service to their project ("connect Linear", "give my agents
Exa"). At the end, the project holds the service's credential as a secret, and you have shown with
one read-only call that it works.

The MCP server has one tool, `run({ project?, script })`. `script` is a JavaScript function,
`async (itx) => { … }`, run at the project's root. Every example below is a `script`: send it as
the `script` argument of `run`, and pass `project` (the slug) when the server reaches several
projects.

## Four rules

1. **Never take a secret in the chat.** Don't ask for an API key, a client secret, a token or a
   password, and don't accept one. If the person pastes one anyway, tell them it is now exposed and
   should be revoked, and send them the collection link instead (step 3).
2. **Name a secret, never its value.** You can't read a secret, and you don't need to. Put
   `getSecret("/secrets/<name>")` where the value goes, in a header or a URL. The platform swaps the
   real value in on the way out, and only to the origins the secret is pinned to. It never looks at
   a request body.
3. **One step at a time. When the person has to do something (open a link, create an app), end your
   turn.** Say exactly what to do, then wait for them to reply "done". Don't poll and don't guess.
4. **Prove it before you say it's connected:** one read-only call that returns real data.

## 1. Look at the project

```js
async (itx) => ({
  project: await itx.whoami(),
  secrets: (await itx.secrets.list()).map((secret) => ({ path: secret.path, urls: secret.urls })),
});
```

If a secret for the service already exists, go straight to step 4 with it.

Slack, Google, Cloudflare, GitHub (as a GitHub App installation) and Waitrose are built in: for
those, tell the person to open their project's **Integrations** page in the Dash and press
**Connect**. That is one click, and you are done.

## 2. Find out how the service is reached, then pick a path

Search the service's own documentation and answer:

- Does it run a **hosted MCP server**? Its URL, and the header that carries the key.
- Does it publish an **OpenAPI document**? Its URL.
- Its **REST API origin** (`https://api.example.com`) and how a key is sent
  (`Authorization: Bearer <key>`, `x-api-key: <key>`, a query parameter).
- Does it support **OAuth**? Its authorization and token endpoints, the scopes, and whether its
  token endpoint wants the client secret in a Basic header or in the body.
- Where does the person **get an API key**? The exact page in the service's settings.

Then:

| The service offers                                             | Path                     |
| -------------------------------------------------------------- | ------------------------ |
| API keys and a hosted MCP server                               | **A**: key + MCP         |
| API keys and an OpenAPI document                               | **B**: key + OpenAPI     |
| API keys and a REST API                                        | **C**: key + `itx.fetch` |
| OAuth only, or the person wants it to act as their own account | **D**: OAuth             |

Prefer A, then B, then C: an API key is one step for the person. Use D when the service has no API
keys, or when the person asks for their own account.

## 3. Paths A, B and C: collect the key

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/exa",
    // every origin the key may be sent to: scheme and host only, no path
    egress: { urls: ["https://mcp.exa.ai", "https://api.exa.ai"] },
    description: "Your Exa API key, from dashboard.exa.ai/api-keys. It is only ever sent to Exa.",
  });
```

It returns `{ path, url }`. Say to the person, with the real link and the real settings page:

> Open this link, paste your Exa API key into **Value** and press **Set secret**: `<url>`
> You can create a key at `<the service's API keys page>`. Reply "done" when it's saved, and please
> don't paste the key here.

End your turn. When they reply "done", check it's there before going on:

```js
async (itx) =>
  (await itx.secrets.list()).find((secret) => secret.path === "/secrets/exa") ?? "not saved yet";
```

If it isn't there, send the link again.

Pin every host you will call. An MCP server often lives on another host than the REST API
(`mcp.exa.ai` and `api.exa.ai`). A secret pinned to one refuses the other. To change the pin,
collect the secret again at the same path.

## 4. Connect and prove it

### Path A: a hosted MCP server

```js
async (itx) => {
  const mcp = await itx.connectToMcp("https://mcp.exa.ai/mcp", {
    headers: { "x-api-key": 'getSecret("/secrets/exa")' },
  });
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  // pick a read-only tool from `tools` for the proof
  const result = await mcp.callTool("web_search_exa", { query: "iterate", numResults: 1 });
  await mcp.close();
  return { tools, result };
};
```

Many servers want `authorization: 'Bearer getSecret("/secrets/<name>")'` instead of `x-api-key`: use
whatever the service documents.

### Path B: an OpenAPI document

```js
async (itx) => {
  const api = await itx.connectToOpenApi(
    "https://generativelanguage.googleapis.com/$discovery/OPENAPI3_0?version=v1beta",
    { headers: { "x-goog-api-key": 'getSecret("/secrets/gemini")' } },
  );
  const operations = api.operations();
  // a read-only operation for the proof: a GET that lists or reads something
  const list = operations.find(
    (operation) => operation.method.toUpperCase() === "GET" && /list/i.test(operation.operationId),
  );
  return {
    operations: operations
      .slice(0, 30)
      .map((operation) => `${operation.method} ${operation.path} ${operation.operationId}`),
    proof: list
      ? await api.call(list.operationId, {})
      : "no list operation: pick one from `operations`",
  };
};
```

`connectToOpenApi` also takes the document itself instead of a URL, and `{ baseUrl }` when the
requests go somewhere other than the document's first server.

### Path C: plain HTTPS

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.example.com/v1/me", {
      headers: { authorization: 'Bearer getSecret("/secrets/example")' },
    }),
  );
  return { status: response.status, body: (await response.text()).slice(0, 1000) };
};
```

Use `itx.fetch` for every call that carries a secret. A key sent as a query parameter works too:
`https://api.example.com/v1/search?key=getSecret("/secrets/example")`.

## 5. Path D: OAuth

The person registers an OAuth app with the service, and the platform runs the OAuth flow; its
callback is on the platform. You never see the client secret or the tokens.

**D1. The app.** Tell the person where to register it, and exactly what to fill in:

> In `<the service's developer settings page>`, create an OAuth app:
>
> - Name: `iterate <project>`
> - Homepage: the project's URL (`projectUrl` from step 1)
> - Callback / redirect URL: `https://os.iterate.com/.secrets/oauth/callback`
>
> Then send me the app's **client ID** here: it isn't secret. Also tell me what it should be allowed to do.

On a self-hosted iterate, the callback is `/.secrets/oauth/callback` on that deployment's own origin,
the one this guide is served from. End your turn.

**D2. The client secret.** Collect it like a key, pinned to the origin of the service's **token
endpoint**:

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/github-client-secret",
    egress: { urls: ["https://github.com"] }, // the token endpoint's origin
    description: "The client secret of your GitHub OAuth app (Generate a new client secret).",
  });
```

Send the link, end your turn, and check it is there when they reply "done" (step 3).

**D3. The consent.** Start the flow and send the person the link:

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/github", {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    clientId: "Ov23li…", // what the person sent you
    clientSecret: 'getSecret("/secrets/github-client-secret")',
    clientAuth: "client_secret_post", // or "client_secret_basic": whatever the service documents
    scope: "read:user", // the least the person asked for
    // the token endpoint's origin, and every API origin the token may be sent to
    urls: ["https://github.com", "https://api.github.com"],
  });
```

It returns `{ authorizationUrl }`. Say:

> Open this link and approve access: `<authorizationUrl>`. It comes back to iterate, and the page
> says whether it worked. Reply "done" when it does.

End your turn.

- **No client secret at all:** a public client with PKCE only. Leave out `clientSecret`.
- **Extra authorize parameters:** pass them as `extra`. Google wants
  `{ access_type: "offline", prompt: "consent" }` to issue a refresh token.

**D4. The proof.** The tokens are a JSON secret at the path you passed. Use the access token with
`{ field: "accessToken" }`:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("https://api.github.com/user", {
      headers: {
        authorization: 'Bearer getSecret("/secrets/github", { field: "accessToken" })',
        accept: "application/vnd.github+json",
      },
    }),
  );
  return { status: response.status, login: (await response.json()).login };
};
```

A token that expires is refreshed by the platform when the service answers 401, as long as the
service issued a refresh token.

## 6. Tell the person, and write it down for the project's agents

Tell the person what is stored and how it is used, for example:

> Exa is connected: `/secrets/exa`, only ever sent to `mcp.exa.ai` and `api.exa.ai`. The test
> search returned results.

Then record it in the project's config repo, so its agents find it later. Append a line to
`AGENTS.md`, keeping everything already there:

```js
async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const current = (await repo.readFile("AGENTS.md")) ?? "# Agents\n";
  const line =
    '- Exa: MCP at https://mcp.exa.ai/mcp with header `x-api-key: getSecret("/secrets/exa")`.';
  return repo.commitFiles({
    message: "Record the Exa connection",
    changes: [{ path: "AGENTS.md", content: `${current.trimEnd()}\n${line}\n` }],
  });
};
```

A commit to the config repo republishes the project's worker, so tell the person you did it.

## When something goes wrong

| What you see                                                               | What it means, and what to do                                                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Your MCP client won't call `run` ("requires approval")                     | Ask the person to approve iterate's `run` tool in their client. For the Codex CLI: `-c mcp_servers.iterate.tools.run.approval_mode="approve"`.  |
| `… is outside the pin`, or a secret is refused for a host                  | The secret isn't pinned to the host you called. Collect it again at the same path, with that origin added.                                      |
| The service answers 401 or 403                                             | Check the header name and format against its docs (`Bearer`, `x-api-key`, a query parameter), and that the person pasted the right kind of key. |
| The OAuth callback page says "the token endpoint returned no access_token" | The client secret or `clientAuth` is wrong, or the app's callback URL doesn't match exactly. Fix it and run D3 again.                           |
| `beginOAuth` refuses the client secret                                     | The client-secret secret must exist and be pinned to the token endpoint's origin (D2).                                                          |
| The person pasted a key into the chat                                      | Tell them to revoke it, then send the collection link.                                                                                          |
