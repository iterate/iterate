---
status: in-progress
size: medium
---

# Feed: render slack messages + flatten "Ran code" nesting

## Status summary

Spec fleshed out from a prompt + screenshots (assumptions marked below). Implementation not started yet.

## Problem

Looking at a slack agent chat like
`/projects/burper/streams/agents/slack/c08r1smtzgd/ts-1783437255-864399`, the
"Agent chat" preset is nearly useless without expanding lots of collapsed
"Ran code" rows:

1. Slack user chat messages don't render at all — `slack/webhook-received`
   events fall through the agent-ui reducer's `default` case, so there are no
   user bubbles for slack conversations.
2. Bot responses in slack chats don't render either. The bot replies
   imperatively via `slack.chat.postMessage` inside a code step, and slack
   echoes the bot's own message back as another `slack/webhook-received`
   webhook — so rendering webhook-received messages fixes both directions.
3. Expanding a "Ran code …" activity reveals _another_ collapsed "Ran code"
   step which must be clicked again to see the code.
4. Multi-step activities also contain collapsed LLM-request steps
   ("gpt 5.5 16.8k → 754 tok · 17.8 s"). Expanding the activity should just
   show the code that ran followed by its results, default-expanded, without
   the extra nesting and metadata throat-clearing (e.g. the redundant
   "Started 7 Jul 2026, 16:18:53" heading inside the detail).

## Where things live (from exploring current implementation)

- Agent chat rows come from a pure reducer:
  `packages/ui/src/components/events/agent-ui-reducer.ts` (`reduceAgentUiEvent`)
  → `agent_feed_items` table → rendered by
  `apps/os/src/components/agent-feed.tsx` (`AgentFeedView`).
- Expanded/collapsed state is UI-only: `expandedIds: Set<string>` in
  `AgentFeedView`; everything defaults to collapsed.
- Slack webhook payload shape + bot-message detection helpers already exist in
  `apps/os/src/domains/integrations/slack-agent-processor-implementation.ts`
  (`event_callback` envelope, `text`/`ts`/`thread_ts` readers, `isBotMessage`).
- Changing the reduction requires bumping `AGENT_UI_SCHEMA_VERSION` in
  `agent-ui-processor.ts` so browser mirrors rebuild.
- Reducer behavior is covered by `apps/os/src/components/agent-ui-reducer.test.ts`.

## Checklist

### Slack message rendering

- [ ] Handle `slack/webhook-received` in `reduceAgentUiEvent`: for
      `event_callback` message events with text, emit a message item — kind
      `user` for human messages, kind `assistant` for bot messages (detect via
      `bot_id`/bot profile on the inner event). Ignore non-message webhooks,
      message edits/deletes and other subtypes (best-effort).
- [ ] Carry best-effort sender metadata (slack user id / username when present)
      on the message item and show it on the bubble, so slack messages are
      distinguishable from web-composer messages.
- [ ] Render slack message text through the existing `MessageResponse`
      markdown path (slack mrkdwn ≈ markdown is fine as best effort).
- [ ] Bump `AGENT_UI_SCHEMA_VERSION`.
- [ ] Reducer tests: human slack message → user bubble; bot echo → assistant
      bubble; reaction/edit webhooks ignored.

### Ran-code expansion flattening

- [ ] Expanding an activity shows step details directly: steps inside an
      expanded activity default to expanded (code + result visible
      immediately), with individual steps still collapsible via their slim
      header row.
- [ ] Remove the double "Ran code" nesting: the step header inside an expanded
      activity is a slim one-liner (label + duration), not a second
      collapsed-by-default disclosure that repeats the activity summary.
- [ ] Drop metadata throat-clearing in step details (the repeated
      "Started <full date>" line); keep timing info in the slim header.
- [ ] LLM-request steps inside an expanded activity: show the response
      content directly too, with the token/timing meta staying in the header
      line.

## Assumptions (made while fleshing out from the prompt)

- "Default expanded" applies to steps _within an expanded activity_ — the
  activity rows themselves stay collapsed by default in the feed, matching the
  current one-line-per-activity chat layout.
- Bot responses are covered via the slack echo webhook rather than inventing a
  new outgoing-message event type; if a workspace doesn't echo bot messages,
  that's acceptable best-effort for now.
- The yaml-dump `agent/input-added` event that the slack processor emits stays
  unrendered in Agent chat (the webhook-received bubble supersedes it
  visually).

## Implementation log

(append notes here while implementing)
