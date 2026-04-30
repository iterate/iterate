# Events Stream View

This context defines how event streams are projected into renderer-neutral UI data and then rendered into named regions of an interface.

## Language

**Rendered Element**:
A serializable data structure that selects a UI component by `type` and supplies that component's props.
_Avoid_: View item, feed item as the generic term, React component, render payload

**Element Type**:
A flat string that selects a renderer for a **Rendered Element** without encoding slot placement.
_Avoid_: Slot-prefixed type names

**Feed Item**:
A **Rendered Element** rendered in the feed slot.
_Avoid_: Raw item

**Slot**:
A named region of the stream UI that receives **Rendered Elements** from the stream view reducer.
_Avoid_: Outlet, portal, panel as the generic term

**Stream View Reducer**:
A browser-side reducer that projects stream events into **Rendered Elements** grouped by **Slot**.
_Avoid_: Renderer, feed processor when the projection targets more than the feed
_Code_: Use `EventsStreamViewReducer` for the exported reducer contract.

## Relationships

- A **Stream View Reducer** produces zero or more **Rendered Elements**
- A **Rendered Element** belongs to exactly one **Slot**
- A **Rendered Element** has exactly one **Element Type**
- A **Feed Item** is a **Rendered Element** whose **Slot** is the feed
- Exported stream view model types need docstrings because reducers and renderers meet at this boundary
- Do not introduce reducer composition as a named abstraction yet. Prefer a small number of separate reducers with plain helper functions they can call when behavior is genuinely shared.
- The default stream view reducer should be raw-pretty: each event contributes to a raw summary feed item and may also contribute one semantic feed item. Consecutive unsupported events with the same type may be grouped only when each event produced no other feed item, and grouped raw summaries must retain every raw event so the event inspector can navigate through the exact wire log. The other primary reducer is the full raw JSON/YAML array view.
- The visible renderer-mode surface should expose those two product modes. Raw-only and pretty-only modes may remain temporarily for compatibility or debugging, but they are not product modes; clean-renderer links using them should behave as raw-pretty.

## Example dialogue

> **Dev:** "Should this event become a feed row or update the composer?"
> **Domain expert:** "Both are **Rendered Elements**, but they belong to different **Slots**: the audit trace goes to the feed, while the draft suggestion goes to the input slot."

## Flagged ambiguities

- "Feed item" was used to mean both all renderer-mapped data and feed-specific rows. Resolved: **Rendered Element** is the generic concept; **Feed Item** is only feed-positioned usage.
- "Outlet" and "slot" were both used for named UI regions. Resolved: **Slot** is the canonical term.
- Per-slot item taxonomies such as `HeaderViewItem` and `FeedViewItem` add premature complexity. Resolved: all slots contain **Rendered Elements** with `type` and props.
- "Composed reducer" could become a new abstraction too early. Resolved: do not pursue composition now; start with separate reducers and shared helper functions.
- "Processor" conflicts with backend stream processors. Resolved: the browser-side projection contract is a **Stream View Reducer** in docs and code.
