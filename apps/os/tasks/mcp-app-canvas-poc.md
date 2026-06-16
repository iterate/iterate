---
state: todo
priority: medium
size: medium
dependsOn: []
---

# MCP App live canvas POC

Explore adding an MCP App "canvas" surface to the OS MCP server. The idea is
that an MCP client invokes `open_canvas`, gets an inline UI resource, then later
tool/provider/itx activity emits `canvas-updated` events that replace the
canvas contents with sanitized HTML.

## Why

This would give itx scripts and provider tools a durable visual sidecar:

- multiple canvases per MCP session
- each canvas can be updated independently
- model-visible output stays concise
- human-visible output can show live logs, tables, charts, artifacts, provider call graphs, approval UI, or replay state
- the same event stream infrastructure used for MCP session telemetry can drive the UI

## Findings

MCP Apps are the portable MCP-UI direction. A tool can declare a UI resource, and compatible hosts render it as a sandboxed iframe. Display modes are `inline`, `fullscreen`, and `pip`, but host support varies. For this POC, use `inline` only.

Base MCP does not let servers arbitrarily push fresh UI into a chat at any time. The reliable shape is:

1. a user/model invokes a tool
2. the tool result mounts a UI resource
3. the mounted UI stays alive
4. the UI polls, uses SSE, or uses WebSocket to receive updates from our server

ChatGPT web developer mode requires a remote HTTPS MCP endpoint; it cannot connect to localhost. ChatGPT Apps use the Apps SDK metadata pattern, including `openai/outputTemplate` on the tool, tool result `_meta` for widget-private data, and `openai/widgetCSP.connect_domains` for the widget's event stream origin.

Claude documents MCP Apps with inline and fullscreen guidance. The MCP Apps spec includes PiP, but PiP support should be tested per host before relying on it.

## Proposed POC

Add two MCP tools:

- `open_canvas({ title })`
  - creates `canvasId`
  - returns text fallback plus structured content `{ canvasId }`
  - attaches an inline MCP App widget/resource
  - passes widget-private metadata such as `eventsUrl`

- `update_canvas({ canvasId, html })`
  - sanitizes or stores an inert HTML fragment
  - appends an event like `https://events.iterate.com/mcp-server/canvas-updated`
  - payload includes `{ canvasId, version, html }`

The widget/resource:

- renders inline
- reads `canvasId` and `eventsUrl` from tool result metadata
- opens an SSE connection to the events endpoint or polls a snapshot endpoint
- applies only newer versions
- strips scripts, event handler attributes, `javascript:` URLs, iframes, embeds, and other unsafe elements
- sends size updates when content changes

## Prototype

A throwaway local prototype exists at `/tmp/mcp-canvas-poc` in this work session. It is not production code, but it demonstrates:

- multiple canvases
- `open_canvas`
- `update_canvas`
- `ui://iterate/canvas/<canvasId>` resources
- SSE-backed updates
- inline iframe rendering
- basic client-side HTML sanitization

## Open questions

- Should canvas updates be stored in `/mcp-server-sessions/<sessionSlug>` or a separate `/mcp-canvases/<canvasId>` stream?
- Should `update_canvas` be model-visible, app-only, or both?
- Should arbitrary HTML be accepted, or should providers emit a stricter block schema that we render to HTML?
- Do we want one canvas per script execution by default, or explicit canvas
  creation only?
- How should old canvases expire?
- How much of the canvas state should be visible to the model versus widget-private metadata?

## Useful references

- MCP Apps overview: https://modelcontextprotocol.io/extensions/apps/overview
- MCP Apps spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- ChatGPT developer mode: https://platform.openai.com/docs/guides/developer-mode
- ChatGPT MCP apps help: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta
- Claude MCP Apps design guidelines: https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
