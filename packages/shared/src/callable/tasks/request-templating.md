---
state: planned
priority: medium
size: medium
dependsOn: []
---

# JSONata fetch request construction

V1 only supports literal `fetchRequest.headers`, literal `fetchRequest.query`,
path prefix/replace, and a default JSON body from the whole effective payload.
Do not add a mini-template DSL like `{ type: "json", from: "payload" }`.
Advanced request construction should use JSONata because that is the expression
language we already expect to use for payload shaping.

Proposed future shape:

```ts
{
  type: "fetch",
  via: { type: "url", url: "https://api.github.com/repos/acme/app/issues" },
  fetchRequest: {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": { jsonata: "ambient.tenantId" }
    },
    query: {
      dry_run: { jsonata: "dryRun ? 'true' : 'false'" }
    },
    body: {
      jsonata: "{ \"title\": title, \"body\": body, \"labels\": labels }"
    }
  }
}
```

Evaluation input for value dispatch should include:

- effective payload after `passthroughArgs`
- ambient context

Evaluation input for raw `dispatchCallableFetch()` must not expose or read the
streaming request body. It can expose request metadata only:

- method
- URL/path/query
- headers
- ambient context

Policy requirements:

- maximum expression length
- maximum result size
- bounded evaluation time
- no body JSONata in raw streaming mode unless a future body-buffering policy is
  explicit
- secret references stay separate from JSONata expressions
