# Connect a service to an iterate project

You are a coding agent. You reach an iterate project through iterate's MCP server, and the person
asked you to connect a service to it ("connect Linear", "give my agents Exa"). This guide doesn't
know the service. It teaches you how to find out what you need, and then walks you, and the person,
through the connection one step at a time. Do the steps in order.

When you finish, three things are true: the project holds the service's credential as a secret, one
read-only call has shown that it works, and the project's `AGENTS.md` says how to use it.

## How you run code in the project

iterate's MCP server has one tool, `run({ project?, script })`. `script` is the text of one
JavaScript function, `async (itx) => { … }`, and it runs at the project's root. Every code block
below is a `script`: send it as the `script` argument of `run`. Pass `project` (the project's slug)
when the server reaches more than one project.

```js
async (itx) => ({ project: await itx.whoami() });
```

What comes back is what the function returns. Return plain data: strings, numbers, arrays and
objects. A handle, such as a connection, comes back as `{}`, so return what you read from it
instead. A thrown error comes back as its message: read it, change one thing, and run again.

The scripts below are templates. Replace every `<…>` with what you found out, and never run one with
a `<…>` left in it. The values in the examples section at the end are there to check your
reasoning, not to copy.

## Four rules

1. **Never take a secret in the chat.** Don't ask for an API key, a client secret, a token or a
   password, and don't accept one. If the person pastes one anyway, tell them it is now exposed and
   should be revoked, and send them a collection link instead (step 3).
2. **Name a secret, never its value.** You can't read a secret, and you don't need to. Write
   `getSecret("/secrets/<name>")` where the value goes, in a header or a URL. The platform swaps the
   real value in on the way out, and only to the origins the secret is pinned to. It never looks at
   a request body.
3. **When the person has to do something, say exactly what, then wait for it.** Step 3c's wait
   returns the moment they save a secret or approve access. If it gives up, end your turn and wait
   for them to reply "done". Never guess what happened.
4. **Prove it before you say it's connected:** one read-only call that returns real data.

## Step 1. Look at the project

```js
async (itx) => ({
  project: await itx.whoami(),
  secrets: (await itx.secrets.list()).map((secret) => ({ path: secret.path, urls: secret.urls })),
});
```

Then go to the first line that fits:

- **The service is Slack, Google (Gmail, Calendar, Drive; not the Gemini API), Cloudflare, X or
  GitHub (as a GitHub App installation).** These are built in. Get the link that opens its Connect sheet,
  with the provider's name in lower case:

  ```js
  async (itx) => itx.integrations.requestFromUser("<slack|google|cloudflare|github|x>");
  ```

  Send its `url`, then end your turn:

  > <Service> is built into iterate. Open this link and press **Connect**:
  >
  > <url>
  >
  > Reply "done" when it's connected.

  When they reply "done", run step 1 again: the connection is a new secret,
  `/secrets/<provider>-<connection>`. Prove it with step 4C, sending
  `authorization: 'Bearer getSecret("/secrets/<provider>-<connection>", { field: "accessToken" })'`
  to a read-only endpoint from the provider's API docs. Then go to step 6. For X that is
  `GET https://api.x.com/2/users/me` (its bookmarks, mentions and posts are under
  `/2/users/<id>/…`); a token only does what the scopes it was granted allow, and the Connect
  sheet's default is read-only. Anything that posts or reads bookmarks or DMs needs
  `requestFromUser("x", { scopes: ["tweet.write"] })` (or `bookmark.read`, `dm.read`).

  If the person wants their own OAuth app instead (for example a GitHub OAuth App that acts as
  them), carry on at step 2.

- **A secret for the service is already listed:** go to step 5.
- **Otherwise:** go to step 2.

## Step 2. Find out how the service is reached

You need four facts. Find each one yourself, from the service's own documentation and from the
service itself. Never guess one.

1. **Does it run a hosted MCP server?** Search its docs for "MCP". The URL usually ends in `/mcp`.
2. **How does it authenticate?** Read its "Authentication" or "API keys" page, and find one `curl`
   example in its API reference. The header in that example is the answer. It is usually
   `Authorization: Bearer <key>`, `x-api-key: <key>` or a query parameter.
3. **Where does the person get a key?** The exact page in the service's settings.
4. **One read-only call:** something that lists or reads (the account, models, projects), never one
   that writes, sends or spends.

Then ask the service itself. A call without credentials shows how it wants to be authenticated. For
an MCP server, send it the MCP handshake:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("<the MCP server's URL>", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "iterate", version: "1" },
        },
      }),
    }),
  );
  return {
    status: response.status,
    authenticate: response.headers.get("www-authenticate"),
    body: (await response.text()).slice(0, 300),
  };
};
```

For a REST API, send one plain `GET` to the read-only call's URL. Then read the answer:

| The answer                                           | What it means                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `401` with `resource_metadata="…"` in `authenticate` | It signs in with OAuth. Keep that URL: step 4D starts from it. It may also take a key: check docs. |
| `401` or `403` without it                            | It wants a key, in the header its docs name.                                                       |
| `200`                                                | It answers without a key, perhaps with limits. Its docs say what a key adds.                       |
| `404`, or HTML                                       | Wrong URL. Go back to the docs.                                                                    |

Now pick a path. Go down the table and take the first "yes": the higher, the less the person has
to do.

| Question                                                                                                       | Yes → path                  |
| -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| An MCP server that signs in with OAuth (`resource_metadata`), and its metadata lists a `registration_endpoint` | **D**: OAuth, step 4D       |
| No API keys at all, or the person asked for it to act as their own account through OAuth                       | **D**: OAuth, step 4D       |
| An MCP server that takes the API key                                                                           | **A**: key + MCP, step 4A   |
| A JSON OpenAPI 3 document (not YAML, not Swagger 2)                                                            | **B**: key + OpenAPI, 4B    |
| Anything else with an API key                                                                                  | **C**: key + HTTPS, step 4C |

Paths A, B and C start with step 3. Path D starts at step 4D. An origin, below, is a URL's scheme
and host only (`https://api.example.com`), with no path.

## Writing the key into a request

Every script below sends the key the way the service's docs do, with the placeholder where the key
goes. Copy the header from the docs' `curl` example:

| The docs say                              | Write                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `Authorization: Bearer <key>`             | `authorization: 'Bearer getSecret("/secrets/<name>")'`                   |
| `Authorization: <key>` (no `Bearer`)      | `authorization: 'getSecret("/secrets/<name>")'`                          |
| `X-Api-Key: <key>`, or any other header   | `"x-api-key": 'getSecret("/secrets/<name>")'`                            |
| `?api_key=<key>` in the URL               | `https://api.example.com/v1/search?api_key=getSecret("/secrets/<name>")` |
| Another header too (a version, an accept) | Add it as it is: it isn't secret.                                        |

## Step 3. Collect the key (paths A, B and C)

**3a.** Make the collection link. `path` is `/secrets/` plus the service's name in lower case.
`urls` lists every origin you will send the key to, for example both the MCP server's and the REST
API's when they differ. `description` is markdown, shown above the form: say what the value is and
link to the page where the person gets it (links open in a new tab).

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/<service>",
    egress: { urls: ["<every origin the key goes to>"] },
    description:
      "Your <Service> API key, from [<Service>'s API keys page](<its keys page>). It is only ever sent to <Service>.",
  });
```

It returns `{ path, url }`.

A secret of several parts (an app's client secret and signing secret) is one link with `fields`: the page asks for each, and saves them as one JSON secret whose parts are
`getSecret("/secrets/<name>", { field: "<name of the part>" })`:

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/<service>-app",
    egress: { urls: ["<every origin a part goes to>"] },
    description: "Your <Service> app's credentials, from [its settings](<the app's page>).",
    fields: [
      { name: "clientSecret", label: "Client secret" },
      { name: "signingSecret", label: "Signing secret" },
    ],
  });
```

A field with `multiline: true` takes several lines, such as a PEM private key.

**3b.** Send the person this message, with the real link and the real keys page. Put the link on a
line of its own, exactly as returned: no backticks, no link text.

> Open this link, paste your <Service> API key into **Value** and press **Save** (**Update** if it
> replaces one):
>
> <url>
>
> You can create a key at <its keys page>. I'll see it as soon as it's saved. Please don't paste
> the key here.

**3c.** Right after sending it, wait for the save. This returns `"saved"` the moment the person
presses **Save**:

```js
async (itx) => {
  const path = "/secrets/<service>";
  // a new secret already saved (the person was quick): no wait
  if ((await itx.secrets.list()).some((secret) => secret.path === path)) return "saved";
  return itx
    .cd(path)
    .waitForEvent({ type: "events.iterate.com/secret/set", timeoutMs: 50_000 })
    .then(
      () => "saved",
      () => "not saved yet",
    );
};
```

`"not saved yet"` after 50 seconds: run it again, up to five times. Then end your turn, and ask the
person to reply "done" when it's saved. When a secret is being replaced, leave out the `list()`
check, so the wait is for the new save.

**3d.** Once it says `"saved"`, or the person replies "done", check that the secret is there:

```js
async (itx) =>
  (await itx.secrets.list()).find((secret) => secret.path === "/secrets/<service>") ??
  "not saved yet";
```

- `"not saved yet"`: send the same link again (3b), and wait again (3c).
- It's there: go to 4A, 4B or 4C, whichever step 2 chose.

## Step 4A. A hosted MCP server

Connect with the key (see "Writing the key into a request"), and look at what the server offers:

```js
async (itx) => {
  const mcp = await itx.connectToMcp("<the MCP server's URL>", {
    headers: { authorization: 'Bearer getSecret("/secrets/<service>")' }, // or as the docs say
  });
  const tools = (await mcp.listTools()).map((tool) => ({
    name: tool.name,
    description: (tool.description ?? "").slice(0, 120),
    args: Object.keys(tool.inputSchema?.properties ?? {}),
  }));
  await mcp.close();
  return tools;
};
```

Pick one tool that searches, lists or reads, and call it with the arguments it takes:

```js
async (itx) => {
  const mcp = await itx.connectToMcp("<the MCP server's URL>", {
    headers: { authorization: 'Bearer getSecret("/secrets/<service>")' }, // or as the docs say
  });
  const result = await mcp.callTool("<a read-only tool>", { "<arg>": "<value>" });
  await mcp.close();
  return result;
};
```

It returned real data: go to step 6. It didn't: see "When something goes wrong".

## Step 4B. An OpenAPI document

Connect, and look at the operations. Each `operationId` is a method of the connection:

```js
async (itx) => {
  const api = await itx.connectToOpenApi("<the document's URL>", {
    // only when the document isn't on the API's own host: the key then goes to the API only
    baseUrl: "<the API's base URL>",
    headers: { authorization: 'Bearer getSecret("/secrets/<service>")' }, // or as the docs say
  });
  return (await api.operations())
    .filter((operation) => operation.method.toUpperCase() === "GET")
    .map((operation) => ({
      id: operation.operationId,
      path: operation.path,
      params: operation.parameters.map((parameter) => `${parameter.in}:${parameter.name}`),
    }))
    .slice(0, 60);
};
```

Pick one that lists or reads, and call it: `await api["<operationId>"]({ "<param>": "<value>" })`,
or `await api.call("<operationId>", {…})` when the operationId isn't a plain name
(`list-models`, `models.list`). Path, query and header parameters all go in that one object.

It returned real data: go to step 6. The document won't load, or it isn't JSON OpenAPI 3: use 4C
instead, with the same secret.

## Step 4C. Plain HTTPS

Send the read-only call through `itx.fetch`, with the placeholder where the key goes:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("<the read-only call's URL>", {
      headers: { authorization: 'Bearer getSecret("/secrets/<service>")' }, // or as the docs say
    }),
  );
  return { status: response.status, body: (await response.text()).slice(0, 1000) };
};
```

A POST works the same way: the key in a header, the JSON in the `body`. Status 200 with real data:
go to step 6. Anything else: see "When something goes wrong".

## Step 4D. OAuth

The platform runs the OAuth flow. Its callback is on the platform, and you never see a client
secret or the tokens. You need an OAuth client first, and there are two ways to get one:

- **The service registers clients itself** (its metadata lists a `registration_endpoint`; many
  hosted MCP servers do): you register one in D1a. The person only approves access.
- **Otherwise** the person registers an OAuth app with the service (D1b), and saves its client
  secret through a link. Then they approve access.

**D0. Find the endpoints.** Start from the `resource_metadata` URL step 2's probe returned. With
none, use the service's auth origin from its OAuth docs as `issuer`:

```js
async (itx) => {
  const read = async (url) => {
    const response = await itx.fetch(new Request(url));
    return response.ok ? response.json() : null;
  };
  const resource = await read("<the resource_metadata URL, or null>");
  const issuer = resource?.authorization_servers?.[0] ?? "<the service's auth origin>";
  const metadata =
    (await read(`${issuer}/.well-known/oauth-authorization-server`)) ??
    (await read(`${issuer}/.well-known/openid-configuration`));
  if (!metadata) return "no metadata: read the service's OAuth documentation";
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint ?? null,
    clientAuth: metadata.token_endpoint_auth_methods_supported,
    scopes: metadata.scopes_supported,
  };
};
```

No metadata at all (GitHub, for one): the service's OAuth docs give the authorization and token
endpoints, the scopes, and whether the token endpoint wants the client secret in the form body
(`client_secret_post`) or in a Basic header (`client_secret_basic`).

The authorization server can live on another host than the API or MCP server. The token then goes
to both, so D2's `urls` names both origins.

**D1a. `registrationEndpoint` is set: register a client yourself.** No app and no client secret:

```js
async (itx) => {
  const response = await itx.fetch(
    new Request("<the registration endpoint>", {
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

Keep the `clientId`, and go straight to D2 with `clientAuth: "none"` and no `clientSecret`. Nothing
for the person to do yet.

**D1b. Otherwise: the person's app, and one link for its secrets.** Make the link first: the app's
secret parts as fields of one secret (step 3a), pinned to the token endpoint's origin. Its client ID
is no secret, so the person sends it in the chat:

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/<service>-app",
    egress: { urls: ["<the token endpoint's origin>"] },
    description:
      "Your <Service> OAuth app, from [its settings](<the page that lists your apps>). The client secret is only ever sent to <Service>.",
    fields: [{ name: "clientSecret", label: "Client secret" }],
  });
```

Then find, in the service's docs, the page where an OAuth app is registered and the names of its
fields, and tell the person exactly what to fill in:

> Let's register an OAuth app with <Service>:
>
> 1. Open <the page that registers an app> and fill in:
>    - **<its name field>**: `iterate <project>`
>    - **<its homepage field, if any>**: `<projectUrl from step 1>`
>    - **<its callback or redirect URL field>**: `https://os.iterate.com/.secrets/oauth/callback`
> 2. Save it, then create a client secret.
> 3. Paste its **Client secret** here and press **Save**:
>
>    <url>
>
>    Please don't paste it into this chat.
>
> 4. Reply with the app's **Client ID** (it isn't secret), and what it should be allowed to do.

On a self-hosted iterate, the callback is `/.secrets/oauth/callback` on the origin this guide is
served from. End your turn: you need their answer to 4.

**D2. The consent.** After D1b, first check that the app is saved (step 3d, with
`/secrets/<service>-app`). Then start the flow:

```js
async (itx) =>
  itx.secrets.beginOAuth("/secrets/<service>", {
    authorizationEndpoint: "<authorization endpoint>",
    tokenEndpoint: "<token endpoint>",
    clientId: "<the client ID: what D1a returned, or what the person sent after D1b>",
    // D1b only; leave it out after D1a:
    clientSecret: 'getSecret("/secrets/<service>-app", { field: "clientSecret" })',
    clientAuth: "<none after D1a; client_secret_post or client_secret_basic after D1b>",
    scope: "<the least the person asked for, space-separated>",
    // the token endpoint's origin, and every origin the token will be sent to
    urls: ["<origins>"],
  });
```

It returns `{ authorizationUrl }`. Say, with the link on a line of its own:

> Open this link and approve access:
>
> <authorizationUrl>
>
> It comes back to iterate, and the page says whether it worked. If it says anything but **Done**,
> send me what it says.

Then wait for the tokens the way 3c waits, with `path` set to `/secrets/<service>` (the path you
passed to `beginOAuth`), without the `list()` check, and with a `timeoutMs` of up to 110_000 if your client
allows a call that long. The link works for an hour. If the person comes back later, or the page
says it expired, run D2 again and send the new link.

- **The person's app has no client secret** (a public client, PKCE only): skip D1b's link, leave
  `clientSecret` out, and pass `clientAuth: "none"`.
- **The app signs its webhooks** (Slack's signing secret, GitHub's webhook secret): add the
  field in D1b, and check a webhook with
  `itx.secrets.verifyHmac("/secrets/<service>-app", { payload, signature, field: "signingSecret" })`.
- **Extra authorize parameters** go in `extra`, when the service's docs ask for them (Google wants
  `{ access_type: "offline", prompt: "consent" }` before it issues a refresh token).

**D3. The proof.** The tokens are a JSON secret at the path you passed to `beginOAuth`. Send the
access token as `getSecret("/secrets/<service>", { field: "accessToken" })`, usually as
`authorization: 'Bearer getSecret("/secrets/<service>", { field: "accessToken" })'`, in step 4A's
scripts for an MCP server, or step 4C's for a REST API. A token that expires is refreshed by the
platform when the service answers 401, as long as the service issued a refresh token. Go to step 6.

## Step 5. The secret already exists

Run the proof for its path with the existing secret: 4A, 4B or 4C for a key, D3 for OAuth. If it
works, go to step 6. If the service answers 401 or 403, the stored value is wrong or expired:
collect it again at the same path (step 3), which replaces it.

## Step 6. Tell the person, and write it down for the project's agents

Only after the proof worked: record how to call the service in the project's config repo, so its
agents find it later. One line: the URL, the header with its placeholder, and one call that works.
This keeps everything in `AGENTS.md` and replaces the service's line if there is one:

```js
async (itx) => {
  const repo = itx.repos.get("/repos/config");
  const current = (await repo.readFile("AGENTS.md")) ?? "# Agents\n";
  const line =
    "- <Service>: <how to call it: URL, header with its getSecret placeholder, one call>";
  const kept = current
    .trimEnd()
    .split("\n")
    .filter((old) => !old.startsWith("- <Service>:"));
  return repo.commitFiles({
    message: "Record the <Service> connection",
    changes: [{ path: "AGENTS.md", content: `${[...kept, line].join("\n")}\n` }],
  });
};
```

Then tell the person what is stored, where it may go, and what the proof showed, for example:

> <Service> is connected. The key is at `/secrets/<service>`, and it is only ever sent to
> `<its hosts>`. <What the read-only call returned.> I noted it in the project's `AGENTS.md`, which
> republishes the project's worker.

## Examples, to check your reasoning

Each row was connected this way on 2026-09-28. Services change: your research wins over this table.

| Service                             | Path | What decided it                                                                                                   |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| Exa                                 | A    | MCP at `https://mcp.exa.ai/mcp`, key in `x-api-key`; pinned to `mcp.exa.ai` and `api.exa.ai`                      |
| Gemini API                          | B    | JSON OpenAPI at `generativelanguage.googleapis.com/$discovery/OPENAPI3_0?version=v1beta`, key in `x-goog-api-key` |
| OpenAI                              | C    | Its OpenAPI document is on GitHub (so B needs `baseUrl`); `GET https://api.openai.com/v1/models` with `Bearer`    |
| Linear, signing in                  | D1a  | The MCP probe's 401 named `resource_metadata`; its metadata lists `https://mcp.linear.app/register`               |
| GitHub, as the person's own account | D1b  | No metadata; the person registered an OAuth App; `client_secret_post`; GitHub's API wants a `user-agent` header   |

## When something goes wrong

Read the error first: most say what's wrong.

| What you see                                                                          | What it means, and what to do                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your MCP client won't call `run` ("requires approval")                                | Ask the person to approve iterate's `run` tool in their client. For the Codex CLI: `-c mcp_servers.iterate.tools.run.approval_mode="approve"`.                                                                                                                      |
| `no stored project secret for getSecret("/secrets/…")`                                | Nothing is saved at that path yet. Check the path, then send the collection link again (step 3b).                                                                                                                                                                   |
| `the secret /secrets/… is pinned to … — not sent to …`                                | The secret isn't pinned to the host you called. Collect it again at the same path, with that origin added to `urls`.                                                                                                                                                |
| `connectToOpenApi: fetching … returned 502` for a document on another host            | The key was headed to the document's host. Pass `baseUrl` (step 4B).                                                                                                                                                                                                |
| `… is not an OpenAPI 3 document`                                                      | It's YAML or Swagger 2. Use step 4C with the same secret.                                                                                                                                                                                                           |
| The service answers 401 or 403                                                        | Check the header against the docs' `curl` example ("Writing the key into a request"), then the key itself: its kind, its scopes, and its region (some services have separate hosts per region). Tell the person exactly which key to make, and send the link again. |
| The OAuth callback page says `the token endpoint returned no access_token`            | The client secret or `clientAuth` is wrong, or the app's callback URL doesn't match exactly. Fix it and run D2 again.                                                                                                                                               |
| `beginOAuth` refuses the client secret                                                | The app's secret must exist, hold the fields its placeholders name, and be pinned to the token endpoint's origin (D1b).                                                                                                                                             |
| `The operation timed out.`                                                            | Run the same script once more.                                                                                                                                                                                                                                      |
| `The RPC receiver does not implement the method "…"`                                  | That name isn't there: check it against `listTools()` or `operations()`, and that you awaited the connection.                                                                                                                                                       |
| The callback page says `This link is not one the platform issued, or it has expired.` | The consent link works for an hour. Run D2 again and send the new link.                                                                                                                                                                                             |
| The person pasted a key into the chat                                                 | Tell them to revoke it and make a new one, then send the collection link.                                                                                                                                                                                           |
