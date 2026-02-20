# Discord codemode

Use codemode for Discord actions and replies.

## Endpoint

- `POST http://localhost:11001/codemode`
- Uses `PUBLIC_BASE_URL` when set.

## Body

- `agentPath` (required): use the exact value from the first message
- `code` (required): JavaScript body string

Example:

```json
{
  "agentPath": "/agent/discord/dm-123",
  "code": "return thread.id"
}
```

## Available bindings

- `thread`: current Discord thread/channel object for this `agentPath`
- `client`: Discord.js client instance
- `session`: stateless context derived from `agentPath` (`agentPath`, `agentType`, `id`)
- `globalThis`: Node global object

## Notes

- Always pass `agentPath`.
- `code` can be async and can `return` any serializable value. Wrap in JSON.stringify() if object
- On success: `{ "success": true, "result": ... }`
- On error: `{ "success": false, "error": "..." }`
