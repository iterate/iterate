Some coding rules

- use "bag of objects" as function arguments always
- don't eclare types that can be inferred
- no single-use helpers!!! and if you must have lil helper functions, put them at the bottom of the file
- use comments to explain context / why somethign is how it is. don't be afraid to give examples and DO link to first party docs
- always cross reference against official cloudflare docs
- things you only need once can and should be inline. e.g. don't create a massive typescript interface for something you only use once mate. just inline it.
- most functions/methods should have a single `(args: { ... })` argument object. don't deconstruct it inside the function header

- DON'T use crazy string constants like SUBSCRIPTION_CONFIGURED_TYPE = "subscription-configured". Use the actual string - the type system makes it safe

## sqlfu

Each stream version owns its own sqlfu project beside the Durable Object code.
For v0, run sqlfu commands from `src/stream/v0`:

```bash
cd packages/stream-benchmark/src/stream/v0
pnpm exec sqlfu generate
pnpm exec sqlfu check migrations-match-definitions
```
