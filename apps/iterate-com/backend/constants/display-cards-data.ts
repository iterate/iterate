export const DISPLAY_CARD_THREADS = [
  {
    ask: "@iterate sync my PRs from this week to Linear tickets",
    reply:
      "✅ Updated 3 tickets:\n• ENG-231: Marked as 'In Review' (PR #1847)\n• ENG-244: Moved to 'Done' (PR #1852 merged)\n• OPS-19: Added PR link (PR #1855)\n\nPosted summary to #eng-standup",
  },
  {
    ask: "@iterate add these interview notes to Notion and summarize for the team",
    reply:
      "📝 Added to Notion → Candidates database:\n• 5 new interview entries created\n• Tagged with 'frontend' and 'senior'\n\nSummary posted to #hiring:\n\"Strong React/TS skills across all candidates. 3 have startup experience. Recommend moving Alex and Sam to next round.\"",
  },
  {
    ask: "@iterate create a GitHub issue from this bug report and assign to on-call",
    reply:
      "🐛 Created issue #1893: \"API timeout on bulk exports\"\n• Labeled as 'bug' and 'p1-urgent'\n• Assigned to @sarah (current on-call)\n• Added reproduction steps from thread\n• Linked to Sentry error ASX-4829",
  },
  {
    ask: "@iterate what tickets are blocked waiting for design review?",
    reply:
      "🎨 Found 4 blocked tickets:\n• ENG-198: New onboarding flow (blocked 3 days)\n• ENG-205: Settings redesign (blocked 1 day)\n• PROD-84: Mobile navigation (blocked 5 days)\n• ENG-211: Dashboard widgets (blocked 2 days)\n\nPinged @design-team in #design-reviews",
  },
];
