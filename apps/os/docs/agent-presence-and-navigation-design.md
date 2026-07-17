# Agent Presence And Navigation Design

Status: implemented in this PR

Delivery shape: one clean-break PR

Reviewed against the current codebase and critiqued by Claude Fable at `xhigh` effort

## Outcome

Agents should read as durable project participants, not as decorated stream paths.

This PR replaces the current agent status/roster model and all of its principal UI:

- a rich agent identity and presence model;
- one shared React component family for agent detail, catalog, and sidebar density;
- a useful `/agents` catalog with hierarchy and project-global pinning;
- a compact live-agents section in the project sidebar;
- a rich header on an individual agent conversation;
- a three-mode `⌘K` palette for Stream tree, Agents, and Recent streams;
- typed Slack, Telegram, email, and GitHub bindings;
- correct ephemeral Slack thread activity that clears when runtime work ends.

The generic event stream remains available for inspection, but it is deliberately small and secondary on the `/agents` catalog.

## Hard Boundary: Clean Replacement Only

There is no legacy or backwards-compatibility work in this design.

The implementation must:

- delete `itx.agent.setStatus`;
- delete `itx.agent.setTitle`;
- stop emitting and consuming `events.iterate.com/agent/status-changed`;
- delete `AgentStatusRecord`, `mergeAgentStatusPatch`, and `AgentStatusDatabase`;
- delete the old roster component and path-derived source-label logic;
- delete the old `/agents` stream-tree/roster layout;
- update or replace old fixtures, generated APIs, prompts, and tests in the same PR;
- understand only the new metadata and runtime events.

It must not add:

- dual reads or writes;
- a legacy event translator;
- a migration or backfill;
- a compatibility projection;
- a fallback from the new record to the old status record;
- redirects or preserved UI solely for the old agent model.

The affected production project will be erased and recreated at cutover. The coordinated production sequence is: quiesce affected ingress, erase the project, deploy the new contract, recreate the project and its integration configuration through normal APIs, run smoke tests, and resume ingress. This document does not authorize or perform that production operation.

Bounded refolding of the **new** event families after a transient projection failure is still required. That is operational recovery for current data, not backwards compatibility. It must be bounded, observable, and fail loudly if the projection cannot converge.

## Product Decisions

1. An agent has one normalized domain record and one React component family with `detail`, `catalog`, and `sidebar` variants.
2. Mobile and desktop are responsive presentations of those variants, not additional data models.
3. Metadata and runtime/structural fields are structurally separate because they have different meanings and update patterns, not because the writer matters.
4. `title`, `summary`, `activity`, `waitingFor`, and project-global `pinned` are mutable metadata.
5. Runtime counts, paths, timestamps, relationships, and integration bindings are reduced from matching event families.
6. `activity` is the concise human-readable current condition. There is no second authored `status` string.
7. `summary` is one or two sentences and appears only in spacious UI.
8. `waitingFor` describes the next dependency after current work has stopped. It is absent when no dependency is declared.
9. Runtime is represented as counts first. Compact UI derives a display literal; that literal is not stored.
10. A progress visual represents real phases and counts. The UI does not invent percentage completion.
11. Agent hierarchy comes from actual `agent/created` facts and canonical path ancestry.
12. Pinning adds flat shortcuts. It never changes structural parentage or removes an agent from the main forest.
13. Integration identity is a typed binding and a secondary badge/link, not an editable avatar or a path guess.
14. Slack assistant-thread activity is ephemeral and is always cleared after runtime settles to zero.
15. The complete agent projection is the source for all three UI surfaces; the browser stream mirror remains a feed/inspector concern.

### Append and access model

The project event log is append-open to project members. Anyone with access to a project can append any event type to any stream in that project. There are no reserved agent event types, privileged append lanes, authenticated producer claims, or platform-only fields in this design.

“Metadata”, “runtime”, and “binding” name event meanings only. `setMetadata` and the normal processor/integration behavior are convenient ways to append those events, not special write paths. Reducers interpret every matching valid event by type and payload, regardless of who appended it. A malformed lookalike remains an ordinary raw event and is ignored by that typed reducer. A valid but impossible event sequence may fail a reducer as a data-model violation; that is not an authorization check.

## Canonical Agent Model

The canonical projected record is:

```ts
type AgentRecord = {
  path: string;
  metadata: AgentMetadata;
  runtime: AgentRuntime;
  binding?: AgentBinding;
  timestamps: AgentTimestamps;
};
```

`parentPath` and aggregate descendant state do not belong in the raw record. They are derived from the complete set of created agents.

### Mutable metadata

```ts
type AgentMetadata = {
  title?: string;
  summary?: string;
  activity?: string;
  waitingFor?: "user_input" | "external_event" | "timer";
  pinned: boolean;
};

type AgentMetadataPatch = {
  title?: string | null;
  summary?: string | null;
  activity?: string | null;
  waitingFor?: "user_input" | "external_event" | "timer" | null;
  pinned?: boolean;
};
```

Stored optional fields are absent, never `null`. `null` exists only in the patch type because it means “clear this property”.

Patch semantics:

- omitted means unchanged;
- `null` clears an optional value;
- `pinned: false` unpins;
- values are trimmed;
- an empty or whitespace-only string is invalid, not an alias for clearing;
- unknown properties are rejected;
- a repeated no-op patch does not change any projection timestamp;
- `pinned` defaults to `false` at creation.

Initial limits keep the live record bounded:

| Field      | Meaning                                         |        Maximum |
| ---------- | ----------------------------------------------- | -------------: |
| `title`    | Stable short identity                           | 120 characters |
| `activity` | Current-condition sentence fragment or sentence | 240 characters |
| `summary`  | One or two sentences of wider context           | 600 characters |

The limits apply at the event/API boundary, not only in React.

Field behavior:

- `title` is generated once when the topic is clear and changed rarely. An agent should omit it on subsequent turns unless a rename is genuinely needed or explicitly requested. A human rename uses the same event and is not copied into a second field.
- `activity` changes on most meaningful turns or phases: “Researching cattle near Bath”, “Comparing transport costs”, or “Delivered the recommendation”.
- `summary` changes only when the durable purpose or conclusion materially changes. It is hidden in the sidebar and compact palette results.
- `waitingFor` records a semantic dependency that runtime counts cannot express.
- `pinned` is project-global in this PR. Per-user pinning is deferred.

There is no `note`, `shortStatus`, `blocked`, mutable `icon`, or authored `busy` field.

### Runtime counts

The agent processor already reduces the events needed for a truthful runtime snapshot. The new projection exposes those counts without collapsing away concurrency:

```ts
type AgentRuntime = {
  triggers: {
    pending: number;
    runnable: number;
  };
  llmRequests: {
    scheduled: number;
    requested: number;
    started: number;
  };
  runningScripts: number;
};
```

Current implementation details map as follows:

- `pendingTriggerOffset !== null` contributes one pending trigger;
- that trigger contributes one runnable trigger only after required prompt/config context exists;
- `currentRequest.phase === "scheduled"` contributes one scheduled request;
- open `llmRequests` entries contribute to `requested` or `started`;
- `activeScriptExecutionIds.length` is `runningScripts`.

The values are numbers even where the current processor can only hold zero or one. This avoids another contract change if the scheduler later permits more concurrency.

A pure selector derives the compact state:

```ts
type AgentDisplayState =
  | "running_code"
  | "waiting_for_model"
  | "queued"
  | "waiting_for_user_input"
  | "waiting_for_external_event"
  | "waiting_for_timer"
  | "idle";
```

Precedence:

1. `runningScripts > 0` → `running_code`;
2. requested or started LLM requests → `waiting_for_model`;
3. scheduled LLM request or runnable trigger → `queued`;
4. zero displayable runtime and `waitingFor: "user_input"` → `waiting_for_user_input`;
5. zero displayable runtime and `waitingFor: "external_event"` → `waiting_for_external_event`;
6. zero displayable runtime and `waitingFor: "timer"` → `waiting_for_timer`;
7. otherwise → `idle`.

An unready pending trigger remains an exact diagnostic count, but is not presented as active progress. The runtime model does not yet have a bounded configuration-delivery failure transition, so the UI must not promise an `initializing` state that could persist forever. A future bounded obligation can add an honest failure state.

Large variants show exact non-zero counts when concurrent obligations exist. Compact variants show the primary display state plus a descendant count where relevant.

### Runtime event and debounce

The normal agent processor emits a full snapshot:

```ts
{
  type: "events.iterate.com/agent/runtime-changed",
  payload: {
    sinceOffset: number;
    runtime: AgentRuntime;
  }
}
```

This is a full snapshot, not a merge patch. `sinceOffset` is the generation guard used by folds and project fan-in; it does not need to appear in the presentational `AgentRuntime`.

Runtime announcement rules:

- non-zero snapshots and changes between non-zero phases/counts are emitted immediately;
- the transition to an all-zero snapshot keeps the existing 1,000 ms trailing debounce;
- during that debounce the last non-zero projected runtime remains visible;
- new work cancels the pending zero transition;
- a delayed zero event with an older `sinceOffset` folds to nothing;
- after a real zero announcement, all external live indicators clear.

The debounce is essential. The current loop has one-event gaps between LLM completion and script extraction, and between script completion and the next model turn. Removing it would make OS and Slack flicker idle during healthy multi-step work.

Internal processor names should follow the new model: `status` becomes `runtimeChange`, `announcedStatus` becomes `announcedRuntime`, and the status reconciler becomes a runtime-announcement reconciler.

### `waitingFor` lifecycle

`waitingFor` describes what the agent depends on after its current work has ended:

- `user_input`: an answer, approval, secret, choice, or other user action;
- `external_event`: a webhook, reply, review, check result, or other external fact;
- `timer`: a schedule or passage of time;
- absent: no declared dependency.

`timer` does not claim that a scheduler entry exists. There is no `nextWakeAt` in this PR.

The normal agent processor retires stale waiting metadata on the next qualifying wake:

1. a new user/agent input, external event, or timer trigger is accepted;
2. its offset is newer than the event that set `waitingFor`;
3. the processor appends `agent/waiting-cleared` with `{ throughOffset: triggerOffset }`, using an idempotency key tied to that trigger;
4. folds clear only when the current wait was set at or before `throughOffset`;
5. a newer wait therefore wins even if the clear appends later.

Qualifying means a triggering user-role context item, or a triggering developer-role item with a defined actor other than `script`. Script results, feedback without an actor, and crash-cancel requeues are continuations of the same turn and do not clear waiting. Scheduler-originated messages are not distinguishable as timer wakes today; `timer` describes what the agent expects, not provenance inferred from the event.

### Timestamps

```ts
type AgentTimestamps = {
  createdAt: string;
  lastWorkAt: string;
  metadataUpdatedAt?: string;
  activityUpdatedAt?: string;
  runtimeUpdatedAt?: string;
};
```

All timestamps come from durable event creation times.

- `createdAt` comes from `agent/created`.
- `runtimeUpdatedAt` changes only when an accepted runtime snapshot changes.
- `metadataUpdatedAt` changes only when a metadata value actually changes.
- `activityUpdatedAt` changes only when `activity` actually changes.
- `lastWorkAt` is the latest of creation, accepted runtime transitions, and a changed `activity`.

A title, summary, or pin-only edit does not make the agent look recently active. A no-op patch changes none of these timestamps. A separate generic `lastEventAt` is unnecessary for the agent record; the streams index already owns generic stream activity.

Sorting and relative-time copy use `lastWorkAt`, including descendant aggregation.

### Typed integration bindings

Bindings answer “where does this agent live or what external object is it responsible for?” They are normalized records normally emitted from typed facet birth/configuration and enrichment events. The reducer does not care who appended the binding event.

```ts
type AgentBinding =
  | {
      type: "slack_thread";
      connection: string;
      channelId: string;
      threadTs: string;
      channelName?: string;
      url?: string;
    }
  | {
      type: "telegram_thread";
      connection: string;
      chatId: string;
      messageThreadId?: string;
    }
  | {
      type: "email_thread";
      threadId: string;
      subject?: string;
      counterpart?: string;
    }
  | {
      type: "github_pull_request";
      connection: string;
      installationId: string;
      owner: string;
      repo: string;
      number: number;
      url?: string;
    }
  | {
      type: "github_check_run";
      connection: string;
      installationId: string;
      owner: string;
      repo: string;
      number: number;
      checkRunId?: number;
      headSha?: string;
      url?: string;
    };
```

Each agent has at most one external origin binding. Integration processors translate their facet birth and enrichment facts into the full-snapshot `agent/binding-set` event. This keeps the project projection generic and gives replacement/enrichment one unambiguous meaning. Merely calling Slack or GitHub from an unrelated agent does not attach a binding.

Every binding field is bounded at the event boundary. Presentation-only external labels such as an email subject may be trimmed and clipped before emission; identifiers are validated, never rewritten. Optional external links are length-bounded HTTPS URLs only, so the UI never renders `javascript:`, `data:`, or another active-scheme payload. These bounds, together with the metadata and agent-path bounds, are part of the live-state transport budget.

The existing Slack, Telegram, email, and GitHub facet birth certificates supply most coordinates. Facts discovered later—for example a Slack channel name or GitHub URL—produce a newer full binding snapshot, not agent metadata. A GitHub review child inherits PR context through normal parent ancestry; the actual check-run child may carry one `github_check_run` binding. There is no redundant review binding or `parentAgentPath` field.

Presentation derives:

- the provider icon;
- a concise label such as `#cars`, `owner/repo #123`, or an email subject;
- the external link when available.

The binding badge is secondary to title and activity. An unbound agent gets a generic agent mark. No component guesses a provider from `/agents/slack/...` or `/agents/repos/...`.

Display-title fallback, until metadata has a title:

1. useful binding label;
2. final meaningful path segment;
3. full path.

Fallbacks are never written back into metadata.

## Metadata API And Agent Scripts

The convenient typed metadata API is:

```ts
await itx.agent.setMetadata({
  title: "Bath cattle research",
  summary: "Comparing nearby farms, breeds, prices, and transport options.",
  activity: "Checking livestock listings around Bath",
  waitingFor: null,
});
```

It appends:

```ts
{
  type: "events.iterate.com/agent/metadata-changed",
  payload: AgentMetadataPatch
}
```

The RPC method and event use strict schemas and the merge semantics above. UI title editing and pinning call the same method. Appending the same valid event directly has exactly the same reducer meaning.

### Name and start work

```ts
await Promise.all([
  itx.agent.setMetadata({
    title: "Bath cattle research",
    summary: "Researching cattle sellers and practical purchase options around Bath.",
    activity: "Searching nearby farms and listings",
    waitingFor: null,
  }),
  doTheFirstUsefulWork(),
]);
```

### Move to another phase

```ts
await Promise.all([
  itx.agent.setMetadata({
    activity: "Comparing transport costs and breed suitability",
  }),
  compareOptions(),
]);
```

### Ask the user

```ts
await Promise.all([
  sendReply("What is your maximum transport distance?"),
  itx.agent.setMetadata({
    activity: "Waiting for your preferred transport distance",
    waitingFor: "user_input",
  }),
]);
```

### Wait for an external event or timer

```ts
await itx.agent.setMetadata({
  activity: "Waiting for the farm to confirm availability",
  waitingFor: "external_event",
});

await itx.agent.setMetadata({
  activity: "Waiting for tomorrow's monitoring run",
  waitingFor: "timer",
});
```

### Finish current work

```ts
await Promise.all([
  sendReply(finalAnswer),
  itx.agent.setMetadata({
    activity: "Delivered the farm and transport comparison",
    waitingFor: null,
  }),
]);
```

### Pin or unpin

```ts
await itx.agent.setMetadata({ pinned: true });
await itx.agent.setMetadata({ pinned: false });
```

Any project member can set every field through the same event. The default prompt should tell agents:

- set a title once when the topic becomes clear;
- do not rewrite a good existing title every turn;
- update activity on meaningful phase changes;
- keep summary to one or two sentences and update it rarely;
- set `waitingFor` only when progress genuinely depends on that category;
- rely on the normal processor's guarded auto-clear when a later wake arrives;
- do not normally pin themselves.

## Project Projection

### Why the current projection must be replaced

The current `AgentStatusDatabase` only creates a row after an agent emits `agent/status-changed`. Quiet, just-created agents can therefore be absent from the live roster. The project processor separately has the complete cross-posted `agent/created` list in `reduced.agents`.

The new database uses that complete list as its seed and then folds the new facts:

```text
agent journal
  ├─ agent/created
  ├─ agent/metadata-changed
  ├─ agent/runtime-changed
  ├─ agent/waiting-cleared
  └─ agent/binding-set
          │
          ▼
awaited project indexCommittedBatchFacts
          │
          ▼
AgentDatabase (SQLite materialized projection)
          │
          ▼
ProjectLiveState.agents: Record<path, AgentRecord>
          │
          ▼
shared selectors → detail / catalog / sidebar / ⌘K
```

### `AgentDatabase`

Rename and rewrite `AgentStatusDatabase` as `AgentDatabase`.

Responsibilities:

- store one normalized row per created agent;
- `seedMissing(reduced.agents)` in `getLiveState`, mirroring the existing `StreamDatabase.seedMissing` pattern;
- initialize metadata to `{ pinned: false }`, runtime to zeros, and `lastWorkAt` to `createdAt`;
- fold metadata patches with copy-on-write identity;
- accept runtime snapshots only when their `sinceOffset` is current;
- fold the full normalized binding snapshot;
- update timestamps by the exact rules above;
- expose immutable `Record<string, AgentRecord>` live state;
- retain one technical last-event offset per row for idempotent redelivery;
- retain `waitingForSinceOffset` technically so guarded clear facts cannot erase newer waits.

The project batch fan-in routes `agent/created`, metadata, runtime, guarded waiting clears, and binding snapshots for paths under `/agents/**`. The projection treats the first direct `agent/created` event as the row initializer; it replaces the slightly later cross-post seed timestamp. This is a reducer rule, not an authorization rule. A metadata-only change touches only the affected row in the live diff.

### Durable indexing and recovery

The current detached `#indexAgentStatus` and `#indexStreamActivity` calls can silently lose roster or recency updates, and the former can leave a permanently stale row after its final retry. That violates the project's no-deviant-behaviour principle and would directly undermine Recent streams.

Replace both with one awaited, idempotent Project DO call, `indexCommittedBatchFacts`, before userspace worker delivery. It updates `StreamDatabase` and `AgentDatabase` together from the committed batch. If it fails, `processEventBatch` fails and the existing delivery spine redelivers the same offsets; database offset guards make that safe. This deletes the bespoke roster journal reread, retry ladder, compare-and-replace race, detached recency loss, and terminal stale-row condition.

The project-worker call still follows after indexing. A userspace worker failure redelivers the batch and the indexes no-op by offset. No projection reader or recovery path recognizes `agent/status-changed`.

### Frontend subscription and scale

All normal project surfaces subscribe through `useLiveState((itx) => itx.liveState, state => state.agents)`. They select the stable map and run pure memoized selectors downstream. There is no per-agent subscription and no browser-mirror-derived roster.

The complete map is intentional in this PR because hierarchy, descendant aggregation, pinning, and palette search need project-wide context. To keep it responsible:

- metadata strings are bounded at write time;
- rows and nested records use copy-on-write identity so minimal live diffs stay minimal;
- the sidebar renders hard-capped results;
- the catalog flattens visible tree rows and virtualizes them with the existing `@tanstack/react-virtual`;
- collapsed trees do not mount descendant components;
- a synthetic large-project test measures initial snapshot size, single-row update throughput, and renders 5,000 agents;
- the DOM stays bounded to the virtualization window, not the project size.

The actual live-state transport serialization for 5,000 agents must stay at or below 16 MiB, deliberately half the current 32 MiB serialized RPC value limit. The fixture populates every metadata field to its limit and gives every agent a binding. It also measures a one-row live update and the real concurrent-subscription shape. If it exceeds that budget, server-side catalog paging becomes a ship blocker for this PR, not a silent follow-up. The UI API remains `AgentRecord`/`AgentTreeNode`, so transport paging does not create a second presentation model.

## Hierarchy, Pinning, And Shared Selectors

### Parent derivation

For each created agent, find the nearest proper canonical path ancestor that is also in the created-agent set.

Given:

```text
/agents/research
/agents/research/farms
/agents/research/farms/pricing
```

`farms` is a child of `research`; `pricing` is a child of `farms`. An intermediate stream that never had `agent/created` is not an agent parent.

Rules:

- use path segments, not raw string prefix matching;
- relationship is path ancestry, not creator provenance;
- if a parent agent is created after a deeper agent, the selector reparents the child retroactively on the next project state;
- malformed/non-canonical agent paths are rejected at creation, not patched around in the UI.

### Tree view model

```ts
type AgentTreeNode = {
  agent: AgentRecord;
  parentPath?: string;
  depth: number;
  children: AgentTreeNode[];
  aggregateRuntime: AgentRuntime;
  aggregateWaiting: {
    userInput: number;
    externalEvent: number;
    timer: number;
  };
  aggregateLastWorkAt: string;
};
```

Aggregates include the node itself and every descendant. A collapsed parent therefore still exposes:

- whether any descendant is running code, waiting for a model, or queued;
- counts of semantic waits;
- active descendant count;
- latest descendant work time.

### Pinning

There is always one complete structural forest containing every agent.

Pinned UI is a separate flat shortcut section:

- pinning does not reparent or remove the agent;
- a pinned root shortcut represents that root and its aggregate subtree;
- a pinned child shortcut represents that child's aggregate subtree;
- pinned shortcuts do not expand in place;
- selecting a shortcut opens the real agent;
- the same pinned child remains nested under its parent in the main forest.

### Deterministic ordering

Shared ordering for comparable surfaces:

1. pinned shortcuts by aggregate `lastWorkAt`;
2. structural roots with live runtime in self/descendants;
3. roots waiting for user input;
4. roots waiting for external events or timers;
5. remaining roots by aggregate `lastWorkAt`;
6. canonical path as stable tie-breaker.

Children use the same active/waiting/recency ordering. Pinning does not change sibling order in the structural tree.

## React Component Family

```tsx
type AgentProps = {
  agent: AgentRecord;
  variant: "detail" | "catalog" | "sidebar";
  tree?: {
    depth: number;
    childCount: number;
    expanded: boolean;
    aggregateRuntime: AgentRuntime;
    aggregateWaiting: AgentTreeNode["aggregateWaiting"];
    aggregateLastWorkAt: string;
  };
  actions: {
    onOpen: () => void;
    onTogglePinned: () => void;
    onRename?: () => void;
    onToggleChildren?: () => void;
  };
};
```

Public pieces:

- `Agent`: one composed presentation family;
- `buildAgentForest(records)`: derives ancestry and aggregates;
- `flattenVisibleAgentRows(forest, expandedPaths, filter)`: produces the single flat row model required by virtualization;
- `AgentCatalog`: owns expansion state, the single scroll container, and virtualization;
- selectors for title fallback, display state, tree construction, sorting, filtering, and aggregation;
- small private pieces for identity, activity, runtime rail, binding badges, path, timestamps, and actions.

Use the design-system primitives already present in the app: `Item`, `Badge`, `Tooltip`, `Collapsible`, `DropdownMenu`, and `Tabs`. Do not create three unrelated cards with subtly different status logic.

The command palette cannot nest the interactive `Agent` card inside cmdk's already-interactive `CommandItem`. It instead uses a passive `AgentCommandPresentation` assembled from the same title, display-state, binding-badge, timestamp, and tree selectors. The owning `CommandItem` is the sole option and interprets the passive disclosure/pin hit areas plus documented row-level keyboard actions. This is a navigation projection of the shared component family, not a fourth state model or an independently styled card.

### Content matrix

| Information | Detail                    | Catalog                         | Sidebar                     | Palette navigation row          |
| ----------- | ------------------------- | ------------------------------- | --------------------------- | ------------------------------- |
| Title       | Full, editable            | Full                            | One line                    | One line                        |
| Summary     | Full                      | Up to two sentences             | Hidden                      | Hidden                          |
| Activity    | Full                      | Up to two lines                 | One truncated line          | One truncated line              |
| Runtime     | Primary state and counts  | Primary state and useful counts | Compact rail/icon           | Compact factual dot and label   |
| Waiting for | Full label                | Label                           | Compact copy/icon           | Compact factual label           |
| Binding     | Linked detail             | Linked badge                    | Small secondary badge       | Passive provider icon/badge     |
| Path        | Full and copyable         | Secondary/middle-truncated      | Tooltip or context fragment | Search context/accessibility    |
| Timestamps  | Exact named details       | Relative, exact tooltip         | Relative if space permits   | Relative                        |
| Pin         | Action                    | Action                          | Action/menu                 | Row shortcut and pointer target |
| Children    | Collapsed bounded section | Expandable rows                 | Compact disclosure          | Row-level arrow-key disclosure  |

### Progress visual

Do not show a fake percentage.

Use a small structured state rail or indicator:

- running script: animated code/terminal treatment;
- waiting for model: animated model pulse;
- scheduled/queued: queue treatment;
- semantic wait: static pause/dependency treatment;
- idle: quiet neutral treatment.

Large variants can show exact counts. A collapsed parent combines the strongest aggregate state with a numeric descendant badge. Motion respects reduced-motion preferences.

## Rendering Surfaces

### Individual agent conversation

Keep the conversation as the primary content of `agents/streams/$.tsx`. Add a focused `contextHeader`/`agentHeader` slot to `ProjectStreamView`, immediately below the existing `StreamViewHeader`.

The new header uses `Agent variant="detail"` and includes:

- title editing and pin action;
- summary;
- current activity;
- derived runtime and exact counts;
- waiting dependency;
- binding badges and external links;
- copyable path and timestamps in secondary details;
- a collapsed child-agent summary; opening it reveals a height-capped, independently scrollable catalog-density region with expansion for deeper descendants and a link to the full catalog.

The record comes from the project agent projection. The browser event mirror continues to power the conversation/feed mechanics only.

Do not add another roster or generic stream tree beside the conversation. The current arbitrary-agent route shape can remain; this PR changes the experience and data model, not URLs for their own sake.

### `/agents` catalog

Replace `agents/index.tsx` with `ProjectStreamView layout="fullPanel"` and an `AgentCatalog` panel.

Order:

1. page heading, New agent action, search, and optional state filters;
2. Pinned flat shortcuts;
3. complete structural agent forest;
4. older roots behind progressive disclosure when the initial list is long.

Behavior:

- active descendant work is visible on collapsed roots;
- inactive roots default collapsed; a selected/current tree may initialize expanded;
- search matches title, activity, summary, path, and binding labels;
- filtered tree results retain matching ancestors for context;
- deep indentation is capped and becomes a breadcrumb/level marker on narrow screens;
- visible flattened rows are virtualized for large projects;
- all pinned agents are accessible on this page.

The generic `StreamTree` is removed.

The `/agents` event stream uses the existing full-panel Events button/sheet pattern. The sheet is closed by default, the feed is absent from the main document while closed, and the catalog never shares a prominent split pane with it.

### Project sidebar

Replace `SidebarRecentAgents` with `SidebarAgents`.

Expanded sidebar:

- Pinned first, capped at five shortcuts with a `+N pinned` link;
- then active/waiting roots followed by recent roots;
- at most eight unpinned roots;
- root title, one-line activity, compact runtime/wait rail, descendant badge, and relative time;
- local child disclosure;
- final `Show all agents` link.

Expanded children do not create new server reads. They come from the same tree selector.

Collapsed icon sidebar does not attempt to render tiny agent rows. The Agents navigation item shows an aggregate live/attention count badge. The existing mobile sidebar sheet uses the expanded treatment.

Use “New agent” consistently instead of mixing “New Chat” and “New agent”.

### External integration projections

Slack:

- folds metadata and runtime separately;
- syncs `metadata.title` to the assistant-thread title when supported;
- while debounced runtime is non-zero, shows `metadata.activity` or a runtime-derived fallback;
- on the accepted zero snapshot, always calls `assistant.threads.setStatus` with an empty status;
- does not keep status alive for `waitingFor`;
- appends durable typed channel enrichment rather than stamping `icon`, `title`, or `note`;
- refold/recovery repaints current state idempotently and never replays stale UI effects.

Telegram:

- exposes its thread binding from the birth certificate;
- retains its integration-specific ephemeral typing behavior;
- does not write generic source metadata.

Email:

- exposes thread id, subject, and counterpart as binding facts/fallback labels;
- stops writing email icon/title/note through agent status.

GitHub:

- exposes PR binding facts from the routed PR facet;
- gives check-run child agents explicit typed bindings at creation while review children inherit PR context through ancestry;
- stops writing GitHub icon/title/note through agent status.

## `⌘K` Command Palette

Rename/refactor `StreamSwitcherDialog` into a general `CommandPaletteDialog`.

### Project mode

It has one query input and three tabs:

1. **Stream tree**
2. **Agents**
3. **Recent streams**

The tabs are distinct result models, not interleaved groups.

Default tab:

- on `/agents` or an agent detail route: Agents;
- on another project route: Recent streams;
- after choosing a project outside project context: Recent streams.

State lifecycle:

- query resets when the palette closes;
- query persists when switching tabs during one open;
- keyboard result selection resets on tab switch;
- tree expansion resets on close and initializes the current path's ancestors on open;
- routing closes the palette.

Keyboard and touch:

- `⌘K`/`Ctrl+K` toggles;
- `Escape` closes;
- arrow up/down moves within results;
- `Enter` opens the selected result;
- the shadcn tablist supports normal Tab focus and left/right tab switching;
- all actions remain directly touchable on mobile.

Build on the existing `CommandDialog`, `CommandInput`, `CommandList`, and `CommandItem` cmdk primitives rather than retaining the hand-rolled selected-index/listbox implementation. Custom filtering can preserve ancestor context. Cap or virtualize both Agent and Stream tree results, and do not subscribe to or build their full models while the palette is closed.

### Stream tree tab

- Build the ordinary project tree in memory from the already-live `streamsIndex`.
- Remove the current per-node one-shot subscription/N+1 path.
- Filtering shows matching nodes plus ancestors and auto-expands matches.
- Clearing the query restores the palette-local expansion state.
- Stream path remains primary identity.
- Split search from creation: a distinct footer action creates/opens a typed canonical path only in this tab.

The admin stream explorer is the exception. It can address arbitrary project or `__null__` namespaces without a project live index, so it keeps a clearly named remote/lazy tree data source and exposes only the Stream tree mode. Do not render dead Agents or Recent tabs there.

### Agents tab

- No query: pinned, then active/waiting, then recent.
- Query: search title, activity, summary, path, and binding labels.
- Matching descendants retain parent context.
- Results use the shared sidebar-density agent presentation.
- Opening a result routes to the agent conversation.

### Recent streams tab

- Flat, most-recent-first rows from `streamsIndex`;
- top 50 results, rather than the current arbitrary five-minute window;
- query filters the complete index in memory;
- show path, relative time, event count, and latest event type where useful;
- no tree fallback when the list is empty.

### Outside a project

The existing project-picker step remains. After selection, the user enters the full three-tab project palette. In admin, project selection stays in the admin explorer and leads to remote Stream tree only.

### Mobile

Use the existing near-full-screen dialog size. The tablist must fit 375 px without horizontal page overflow; it may use equal-width short labels or its own contained horizontal scroll. Result indentation is capped.

## Codebase Audit And Cleanup Map

The following is the implementation/removal inventory found in the current codebase.

### Agent contracts, processor, and ITX API

| Current area                                                                  | Change                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domains/agents/agent-processor-contract.ts`                              | Delete `AgentStatusChange`, `AgentStatusRecord`, merge helpers, old status event schema, `status`, and `announcedStatus`. Add strict metadata/runtime schemas, zero defaults, generation-guarded runtime fold, and renamed processor state. Update examples and emitted/consumed events. |
| `src/domains/agents/agent-processor-implementation.ts`                        | Replace `#reconcileStatusAnnouncement` with runtime snapshot reconciliation. Preserve the 1,000 ms trailing idle debounce, genesis-zero suppression, and stale-generation rejection. Add guarded waiting clear on a later qualifying wake.                                               |
| `src/rpc-targets.ts`                                                          | Delete `AgentRpcTarget.setStatus` and `.setTitle`; add `.setMetadata`. Replace detached stream/status indexing and roster rebuild with one awaited `indexCommittedBatchFacts` call. Update capability descriptions.                                                                      |
| `src/domains/agents/agent-defaults.ts`                                        | Replace prompt guidance and examples with `setMetadata`; title once, activity often, summary rarely, semantic waiting, no self-pinning by default.                                                                                                                                       |
| `src/domains/agents/agent-processor-contract.ts::DEFAULT_AGENT_SYSTEM_PROMPT` | Replace the tour's `setTitle`/`setStatus` calls and prose with one `setMetadata` example.                                                                                                                                                                                                |
| `src/itx-api.generated.ts` and `src/itx-api-graph.generated.ts`               | Regenerate from the new contracts. Do not hand-preserve old methods or types.                                                                                                                                                                                                            |
| `packages/iterate/src/itx-api.generated.ts`                                   | Regenerate the published SDK surface; no old agent methods or roster types.                                                                                                                                                                                                              |
| `packages/shared/src/agent-events.ts`                                         | Own canonical runtime payload schemas and event constants shared by backend and browser feed.                                                                                                                                                                                            |
| config-repo generated API/template files                                      | Regenerate API surface; replace old status scripts; add explicit GitHub child binding facts.                                                                                                                                                                                             |

Current `deriveAgentBusy` already contains the important prompt-readiness rule. Re-express it as runtime counts rather than deleting that distinction.

### Project materialized state

| Current area                                                            | Change                                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domains/projects/agent-status-database.ts`                         | Delete/replace with `agent-database.ts` storing `AgentRecord` plus one technical offset and waiting guard.                                                 |
| `src/domains/projects/agent-status-database.test.ts`                    | Replace with created/metadata/runtime/waiting/binding/seed/idempotency/copy-on-write tests for `AgentDatabase`.                                            |
| `src/domains/projects/project-processor-contract.ts` and implementation | Keep `reduced.agents` as the complete created-agent seed. Ensure late agent creation updates the live catalog.                                             |
| `src/domains/projects/project-durable-object.ts`                        | Construct `AgentDatabase`; call `seedMissing(reduced.agents)` beside `StreamDatabase.seedMissing`; expose the new record map; add one atomic index method. |
| `src/domains/projects/project-live-state.ts`                            | Replace `AgentStatusRow` with `AgentRecord` projection types.                                                                                              |
| `src/rpc-targets.ts::processEventBatch`                                 | Await one `indexCommittedBatchFacts` call covering stream recency plus new agent facts before userspace delivery. Delete detached touch/rebuild lanes.     |

### Shared agent UI

| Current area                          | Change                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/components/agent-roster.tsx`     | Remove the bespoke roster/list implementation. Replace with normalized hooks/selectors plus `Agent`, `AgentTree`, `AgentCatalog`, and `SidebarAgents`.             |
| `src/lib/agent-roster-labels.ts`      | Delete path-derived Slack/GitHub/email/Telegram detection and source icons. Binding selectors replace it.                                                          |
| `src/components/agent-roster.test.ts` | Replace path-inference tests with metadata fallback, runtime precedence, tree ancestry, late-parent reparenting, aggregate state, pin shortcut, and sorting tests. |
| `src/components/app-sidebar.tsx`      | Replace unbounded `SidebarRecentAgents`; add capped Pinned/Active/Recent rendering, aggregate badge in icon mode, and consistent “New agent” copy.                 |

### Routes and layouts

| Current area                                                 | Change                                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/_app/projects/$projectSlug/agents/index.tsx`     | Remove `AgentRosterList`, `StreamTree`, split-panel plumbing, and prominent `/agents` feed. Render `AgentCatalog` in `fullPanel`; retain events only in the closed sheet. |
| `src/routes/_app/projects/$projectSlug/agents/streams/$.tsx` | Keep conversation, files, interrupt, and onboarding behavior; add the projected detail header and child section.                                                          |
| `src/components/project-stream-view.tsx` and `.lazy.tsx`     | Add a narrow typed header slot usable by agent detail without duplicating layout.                                                                                         |
| `src/components/stream-view-header.tsx`                      | Keep generic stream controls; avoid duplicating agent identity already shown in the new context header.                                                                   |
| `src/routes/_app/projects/$projectSlug/agents/new.tsx`       | Keep the composer/create flow, but use consistent terminology and let the first turn provide title/activity metadata.                                                     |
| `src/routes/_app/projects/$projectSlug/sandboxes/index.tsx`  | Move off recursive `StreamTree` to the normalized in-memory streams-index renderer before deleting that data path.                                                        |

### Stream tree and command palette

| Current area                                       | Change                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/stream-tree.tsx`                   | Remove its ordinary-project N+1 recursive subscription role. Retain/extract a pure tree renderer over normalized nodes plus a separate clearly named remote data source for admin only.  |
| `src/components/stream-switcher-dialog.tsx`        | Replace with `CommandPaletteDialog`, shared query, three tabs, explicit result state, and separate stream-create footer. Delete the touched-field/five-minute/tree-fallback interaction. |
| `src/components/global-command-palette.tsx`        | Detect route-aware default tab; keep project picker; project navigation uses live indexes; admin exposes remote Stream tree only.                                                        |
| `src/routes/_app.tsx`                              | Mount and label the palette outside project routes so the project picker is actually reachable.                                                                                          |
| `src/lib/stream-navigation.ts` and related helpers | Simplify `StreamNavigator.source` so ordinary project navigation no longer carries a per-node source. Keep only the admin remote-tree capability.                                        |

### Integrations

| Current area                                                       | Change                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domains/integrations/slack-agent-processor-contract.ts`       | Replace mixed status fold with separate metadata/runtime state and typed binding enrichment.                                                                      |
| `src/domains/integrations/slack-agent-processor-implementation.ts` | Stop writing source status metadata; sync title, paint only while runtime is live, and always clear on accepted zero. Preserve idempotent/fresh repaint behavior. |
| `src/domains/integrations/slack-processors.test.ts`                | Add handoff debounce, stale zero, wait-does-not-type, and final clear coverage.                                                                                   |
| Telegram agent contract/implementation/tests                       | Project `telegram_thread` binding; retain Telegram-specific ephemeral typing; no generic metadata stamping.                                                       |
| Email agent contract/implementation/tests                          | Project thread/subject/counterpart binding; delete status/icon/title/note writes.                                                                                 |
| GitHub repo/agent contract/implementation/tests                    | Project PR facts as bindings; bind check-run children while review children inherit ancestry; delete generic source metadata writes.                              |

### Browser feed, fixtures, documentation, and generated surfaces

Replace every use of `agent/status-changed` as a browser-feed terminal/busy boundary with the new runtime event, and bump `BROWSER_FEED_SCHEMA_VERSION` so old reducer snapshots are discarded. The current references include:

- `src/components/agent-ui-reducer.test.ts`;
- `src/domains/agents/stream-repros/iterate-web-2026-07-15-fragmented-activity.*`;
- `src/domains/agents/agent-processors.test.ts`;
- `src/domains/agents/agent-prompt-budgets.test.ts`;
- `src/domains/repos/github-agent-processor-contract.ts`;
- `src/lib/event-docs.test.ts`;
- `src/lib/feed-format.ts`;
- `e2e/vitest/itx-agents.e2e.test.ts`;
- integration contract emitted/consumed event lists and their tests.
- `packages/ui/src/components/events/agent-ui-reducer.ts` and its tests;
- browser-feed `implementation.test.ts` and `projector.test.ts`;
- `packages/iterate/src/itx-api.generated.ts`;
- source `config-repo-template/github-reviews.ts`, followed by regeneration of `config-repo-template.generated.ts`.

The `setStatus` call in `routes/_app/itx-repl.tsx` is unrelated local React state and must not be mechanically renamed.

Delete obsolete snapshots/fixtures when they only prove the old model. Rewrite a fixture only when its underlying behavioral regression remains valuable under the new contract.

## Implementation Sequence Within The PR

This remains one clean-breaking PR, but the work should be built in coherent internal slices:

1. Define metadata/runtime/binding/timestamp schemas and pure folds/selectors.
2. Replace agent processor announcements and ITX metadata API; update prompt and generated surfaces.
3. Replace project `AgentStatusDatabase` with `AgentDatabase` and one awaited, idempotent batch indexer for stream plus agent facts.
4. Change Slack/Telegram/email/GitHub projections and remove source metadata writes.
5. Build shared `Agent`/`AgentTree` components and selector tests.
6. Replace sidebar, `/agents`, and detail header.
7. Replace the command palette and ordinary-project stream tree data path.
8. Remove all old symbols/events/components/tests and run an `rg` zero-reference gate.
9. Run unit, integration, browser, mobile, scale, and preview operational verification.
10. Perform the separately approved production erase/recreate cutover.

No slice lands a compatibility bridge.

## Verification And Acceptance

### Contract and projection

- Every `agent/created` appears in `ProjectLiveState.agents` before it has metadata.
- Metadata omit/clear/false/trim/length/empty/no-op semantics are tested.
- Human and agent calls produce the same metadata event shape.
- A later qualifying wake durably clears the preceding `waitingFor`; same-turn work does not, and a delayed clear cannot erase a newer wait.
- Scheduled, requested, started, multiple open requests, scripts, runnable trigger, and unready trigger permutations produce exact counts.
- Non-zero runtime changes publish immediately.
- LLM→script and script→LLM handoffs do not show an idle frame.
- A newer generation defeats a stale delayed zero.
- Accepted zero arrives after the 1,000 ms debounce and clears all live indicators.
- `AgentDatabase` created-fact initialization, seed convergence, offset idempotency, copy-on-write identity, and awaited redelivery recovery are tested.
- No project read or rebuild recognizes `agent/status-changed`.

### Bindings and integrations

- Slack, Telegram, email, GitHub PR, and GitHub check bindings come from normalized typed facts.
- No provider identity is guessed from a path.
- No integration writes mutable `icon`, `note`, or fallback source title.
- Slack title sync is idempotent.
- Slack status uses current activity only while runtime is non-zero.
- Slack clears after accepted zero even when `waitingFor` remains set.
- Slack recovery/refold cannot repaint a stale status.

### Hierarchy and pinning

- Nearest created ancestor wins.
- A later-created ancestor reparents existing descendants.
- Aggregates include self and all descendants.
- A collapsed parent exposes descendant runtime/wait counts.
- Pinning a child creates a flat shortcut and leaves it nested.
- Sorting is stable under equal timestamps.
- Pin changes are live across two clients.

### UI

- All three variants derive title, display state, binding, waits, and timestamps from shared selectors.
- Summary appears in detail/catalog and not sidebar/palette.
- `/agents` contains no generic `StreamTree`.
- The event feed is not in the main `/agents` DOM while its sheet is closed.
- Sidebar respects five-pinned/eight-unpinned caps and exposes hidden counts plus Show all.
- Detail renders a rich header without weakening chat, files, or interrupt behavior.
- Deep hierarchy and worst-case bounded strings produce `scrollWidth <= clientWidth` at 375 px.
- Reduced-motion users do not receive required state only through animation.
- A 5,000-agent fixture keeps mounted row count bounded by virtualization, does not issue per-agent reads, serializes the real transport snapshot at or below 16 MiB, and handles a single-row live update within its measured budget.

### Command palette

- Three tabs appear in ordinary project context.
- Route-aware default tab is correct.
- Query persistence/reset and per-tab selection reset are deterministic.
- Stream filtering retains ancestors and restores expansion after clear.
- Agents results preserve parent context.
- Recent streams has no five-minute cutoff and caps at 50.
- Search and stream-path creation are separate controls.
- Outside-project picker leads to the full project palette.
- Admin exposes only remote Stream tree and never dials a nonexistent project live index.
- Closed palettes do not subscribe to or build the full Agents/Stream tree models.
- Keyboard, screen-reader roles, and touch behavior have component/browser coverage.

### Liveness and operations

- In browser/e2e verification, a created agent and non-zero runtime transition appear through live state within five seconds of the committed event; accepted idle appears within six seconds, including the deliberate debounce.
- Tests wait on observable state, not fixed sleeps.
- Preview verification creates a fresh project and exercises web, child-agent, and at least one integration path.
- Preview traces show coherent event fan-in, live-state delivery, and no unexplained errors.
- Production cutover uses a fresh project state; it does not carry old journals forward.
- Production smoke verifies catalog, sidebar, detail, palette, metadata update, runtime settle, and external status clearing before ingress resumes.

### Deletion gates

Before merge, scoped `rg` checks return no product references to:

- `AgentStatusRecord`;
- `AgentStatusDatabase`;
- `mergeAgentStatusPatch`;
- `events.iterate.com/agent/status-changed`;
- `itx.agent.setStatus`;
- `itx.agent.setTitle`;
- `shortStatus`;
- agent-status `blocked`;
- agent-status `icon`;
- `SidebarRecentAgents`;
- `AgentRosterList`.

Any unrelated local symbol with the same generic name, such as the ITX REPL's React `setStatus`, is reviewed rather than blindly changed.

## Local Implementation Evidence

As of 2026-07-17, the clean replacement described above is implemented on the feature branch. Preview and production cutover evidence remain separate post-PR gates.

- Repository typechecking and zero-warning linting pass. The `apps/os` unit suite passes 190 files and 1,879 runnable tests, with one explicitly skipped test.
- React Doctor reports no diagnostics in the changed files.
- Focused runtime tests prove the exact 999/1,000 ms idle boundary and both LLM-to-script and script-to-LLM hand-offs without an idle journal frame.
- Mounted DOM scale coverage renders a 5,000-agent catalog with a bounded virtual row count, keeps the transport snapshot below 16 MiB, and applies a one-row live patch inside the measured one-second budget.
- Headed local browser verification covers the catalog, detail, responsive sidebar, all three command-palette tabs, keyboard tree expansion, pin shortcuts, and the secondary Events sheet. At 375 × 812, the catalog and detail have no horizontal page overflow.
- Closing the Events sheet unmounts both the feed and its stream mirror; the closed page has no hidden feed subscription.
- Two independent browser clients observe pin and unpin changes without reload.
- A newly created agent and a subsequent `setMetadata` call appear live without reload. Directly appending a valid runtime event produces the same projected live transition, demonstrating that the event reducer does not distinguish append provenance or grant `setMetadata` special authority.
- A clean reload after the final component extraction has no browser errors. The existing TanStack Start CSRF-development warning is unchanged and outside this design's agent-navigation scope.

## Fable Critique Disposition

Two pre-implementation reviews—the requested Claude Fable `xhigh` source audit and an independent Codex codebase audit—found the product model sound and identified implementation blockers. This revision incorporates:

- explicit runtime event transport and generation guarding;
- preservation of the source-side idle debounce;
- seeding every created agent from project reduced state;
- automatic waiting clear on a later wake;
- a conditional clear fact which cannot erase a newer wait, plus the exact qualifying-wake rule;
- genesis-zero suppression after refold;
- prompt-readiness as a diagnostic count without a false user-visible `initializing` promise;
- Telegram binding and an explicit GitHub check-run child binding;
- one normalized binding snapshot per agent, with GitHub child context inherited through ancestry;
- flat pinned shortcuts and self-plus-descendant aggregation;
- meaningful `lastWorkAt` instead of generic event recency;
- title-update prompt discipline;
- sidebar caps, catalog progressive disclosure, virtualization, and a scale gate;
- late-parent reparenting;
- exact command-palette state and admin behavior;
- existing cmdk primitives, closed-state subscription avoidance, and the outside-project `_app.tsx` mount;
- the `/sandboxes` StreamTree consumer, shared-package browser reducer, SDK generation, and source config template;
- one awaited, idempotent batch indexer replacing silently lossy recency/status fan-in and bespoke rebuild retries;
- strict validation, no-op timestamp rules, and broader acceptance tests.

The critique's suggested migration/backfill/translation path is intentionally rejected. The product decision is a clean replacement with production project erasure and recreation.

## Deferred Work

- Per-user pinning.
- Cumulative cost.
- Cumulative token totals.
- Lifetime runtime and event-count metrics in agent cards.
- Exact scheduled wake timestamps.
- User-configurable avatars, colours, or accent themes.
- Percentage progress without a real domain fact.
- Bulk agent operations.
