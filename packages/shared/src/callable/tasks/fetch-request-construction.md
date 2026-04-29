---
state: in-progress
priority: medium
size: medium
dependsOn: []
---

# JSONata payload and request construction

V1 supports `transformInput`, literal `fetchRequest.headers`, literal
`fetchRequest.query`, path prefix/replace, a default JSON body from the
transformed input, and `fetchRequest.body.jsonata` for JSON body construction.
Do not add a mini-template DSL like `{ type: "json", from: "payload" }`.

The model is one concept across callable operation types:

1. `payload`: the value passed to `dispatchCallable({ payload })`.
2. `input`: the value after `transformInput` runs.
3. operation-specific construction:
   - Fetch builds a `Request` from `input`.
   - Workers RPC passes `input` as the RPC argument by default.
   - Future queue/workflow/dataplane operations can build messages or operation
     inputs from `input`.

`transformInput.shallowMerge` is the tiny merge case. `transformInput.jsonata`
is the general payload-shaping case.

Fetch JSON body construction:

```ts
{
  type: "fetch",
  via: { type: "url", url: "https://api.github.com/repos/acme/app/issues" },
  fetchRequest: {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": "tenant_123"
    },
    query: {
      dry_run: true
    },
    body: {
      jsonata: "{ \"title\": title, \"body\": body, \"tenant\": $ambient.tenantId }"
    }
  }
}
```

RPC input transform:

```ts
{
  type: "workers-rpc",
  via: { type: "env-binding", bindingType: "service", bindingName: "TOOLS" },
  rpcMethod: "callTool",
  transformInput: {
    jsonata: "{ \"provider\": \"github\", \"input\": $ }"
  }
}
```

Future dataplane input/message construction:

```ts
{
  type: "queue-send",
  via: { type: "env-binding", bindingType: "queue", bindingName: "EVENTS" },
  transformInput: {
    shallowMerge: { source: "code-mode" }
  },
  message: {
    jsonata: "{ \"topic\": $ambient.topic, \"payload\": $ }"
  }
}
```

JSONata uses the current input as the root object. Host-owned context is
available as `$ambient`, so caller payload fields and host values stay visibly
separate.

`transformInput` and `fetchRequest.body.jsonata` apply only to
`dispatchCallable()` value dispatch. Raw `dispatchCallableFetch()` already
receives a complete `Request`, so it ignores `transformInput` and rejects
`fetchRequest.body`.

Policy requirements:

- maximum expression length
- maximum result size
- bounded evaluation time
- no body JSONata in raw streaming mode unless a future body-buffering policy is
  explicit
- secret references stay separate from JSONata expressions
