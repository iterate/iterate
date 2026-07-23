---
state: done
tags: [ux, home, sidebar]
author: jonas
---

# Home + sidebar ergonomics

The first-load experience is broken and unergonomic:

- [x] **Sidebar doesn't show existing checkouts.** Both repos say "no checkouts yet" even though checkouts exist (the `/w` workspace lane never reports to the checkout index — only the legacy Yjs lane did).
- [x] **The empty state races the data.** On load the main pane says "Pick a checkout from the sidebar" + New checkout button BEFORE repos/checkouts have loaded. It should say "Loading repos…" with a spinner until the list is known.
- [x] **Sidebar should start minimised** and, like apps/os, remember its last open/collapsed state across visits.
- [x] **Homepage should be a real home.** After loading: show the repos and their checkouts in a bigger layout with a large "Create new checkout" call to action — not just a sidebar echo.
- [x] **Checkouts reverse-chronological + relative timestamps.** Newest first, with "2h ago"-style indicators (index already stores activity timestamps).
- [x] **Breadcrumb loading state.** The header briefly renders the string constant "project", then swaps to "tasks.iterate.com" (the hostname, not the project name). It should render a stable skeleton, then the actual project slug.
