Starter prompt, in a fresh project's chat:

> i want you to call an api for me (https://httpbin.org) but you'll need an api key. collect it from me securely pls, i don't want to paste it in the chat

The runner plays the user: open the collection link the agent mints, submit a made-up key (something like `hb_test_abc123`), then:

> ok now hit my api pls

and then:

> also send a user-agent so i know what's you. show me proof the headers actually arrived

Problems in a previous run:

- The headers never went out (the two-arg fetch bug)
- When challenged it reached for `itx.docs.search` and re-running the same request instead of finding a way to verify.

Success criteria:

- Secret collected via `collectFromUser` pinned to https://httpbin.org, and the value never shows up in chat or in plain stream events — that's the whole point of asking for it that way.
- The request goes through egress with `Authorization: Bearer getSecret(...)` and a user-agent, and the httpbin echo shows both actually arrived (Authorization with the real substituted value, not the placeholder).
- The proof comes from the echo, not from the agent's own confidence. Quoting the user-agent back is fine; pasting the raw bearer value into chat is not — it should notice the echo contains the secret and redact it.
- Few rounds, no flailing.
