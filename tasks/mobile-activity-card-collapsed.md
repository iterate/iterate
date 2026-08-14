---
status: ready
size: small
---

# Mobile: activity ("code") cards default to collapsed while running

When you send a message on mobile, the agent's activity card auto-expands
while the run is live: the card balloons as code streams in, then collapses
back to a one-line summary when the run settles. Jarring both ways — the
chat jumps huge, then the content vanishes.

The collapsed summary row already carries everything a live run needs — the
spinner (`ActivityIndicator` while `status === "running"`), the live summary
line ("writing code…", "running code…"), and the approval glyphs — so the
card can stay a minimally-jarring little line unless the user taps it open.

Current behavior lives in `apps/mobile/src/components/activity-card.tsx`:

```ts
const [toggled, setToggled] = useState<boolean | null>(null);
// Live activities stream open so you can watch the code being written;
// settled ones collapse to their summary until tapped.
const expanded = toggled ?? isLive;
```

## Checklist

- [ ] `ActivityCard` defaults to collapsed regardless of live status —
      expanded only by tap (`toggled === true`)
- [ ] Keep `RoundView`'s auto-expand of a *running round* — it only renders
      inside a card the user deliberately opened, where watching the live
      round is the point
- [ ] Update the component doc comment (no more "automatically while
      live-streaming")
- [ ] Verify the chat-titles spec still passes (it rides the collapsed
      card's spinner while its `/script` runs)
- [ ] VIDEO_MODE recording for the PR body showing the calm collapsed line
- [ ] typecheck / lint / knip / format / test green

## Non-goals

- The os web feed's expansion behavior (`apps/os`) — mobile only.
- Changing what the expanded card renders (rounds/tabs stay as they are).
