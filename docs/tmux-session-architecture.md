# Tmux Session Architecture

This document explains how agent sessions are managed using tmux as the source of truth.

## Overview

Agent sessions are managed through tmux with automatic synchronization to SQLite:

```
┌─────────────────────────────────────────────────────────────┐
│                     User / UI / tRPC                         │
│                                                              │
│  mutations: createSession, startSession, stopSession, etc.   │
└────────────────────────┬────────────────────────────────────┘
                         │ calls tmux commands
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    tmux (vanilla, default socket)            │
│                                                              │
│  Sessions: agent_my-agent, agent_other-agent                 │
│                                                              │
│  Hooks (in ~/.tmux.conf):                                    │
│  ├─ session-created → tsx sync-sessions.ts                  │
│  ├─ session-closed  → tsx sync-sessions.ts                  │
│  └─ session-renamed → tsx sync-sessions.ts                  │
└────────────────────────┬────────────────────────────────────┘
                         │ hook triggers script
                         ▼
┌─────────────────────────────────────────────────────────────┐
│           sync-sessions.ts (standalone script)               │
│                                                              │
│  1. tmux list-sessions                                       │
│  2. Parse agent_slug names                                   │
│  3. Upsert to SQLite                                         │
│  4. Mark missing sessions as stopped                         │
│  5. Trigger resurrect save                                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   SQLite (sessions table)                    │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

### 1. One-Directional Flow

```
tRPC mutation → tmux command → tmux hook → sync script → SQLite
```

The flow is always one-directional. tRPC mutations interact with tmux, and tmux hooks
ensure the database stays in sync.

### 2. Tmux is Source of Truth

Tmux is the authoritative source for whether a session is running. The sync script
reconciles SQLite with tmux state, not the other way around.

### 3. Session Naming Convention

All agent sessions are named `agent_{slug}`:

- `agent_my-cool-agent`
- `agent_another-agent`

This allows the sync script to identify which tmux sessions belong to our system.

## Components

### tmux-control.ts

Low-level tmux wrapper functions:

- `createTmuxSession(name, command)` - Create a new session
- `killTmuxSession(name)` - Kill a session
- `hasTmuxSession(name)` - Check if session exists
- `buildSessionName(slug)` - Returns `agent_{slug}`
- `parseSlugFromSessionName(name)` - Extracts slug from session name
- `triggerResurrectSave()` - Trigger tmux-resurrect save
- `triggerResurrectRestore()` - Trigger tmux-resurrect restore

### sync-sessions.ts

Standalone script called by tmux hooks. Uses `better-sqlite3` directly (not Drizzle)
for isolation and testability.

Actions:

1. List all tmux sessions
2. Filter to `agent_*` sessions
3. Upsert running sessions to DB
4. Mark sessions not in tmux as stopped
5. Trigger resurrect save

### tmux.conf

Configures tmux with:

- Default settings (history-limit, mouse)
- tmux-resurrect plugin for session persistence
- Hooks to call sync-sessions.ts on session changes

## tmux-resurrect

[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) saves and restores
tmux sessions across server restarts.

- **Save location**: `~/.tmux/resurrect/`
- **Manual save**: `prefix + Ctrl-s`
- **Manual restore**: `prefix + Ctrl-r`
- **Programmatic save**: `triggerResurrectSave()` in tmux-control.ts

### When Resurrect Save is Triggered

1. After every session create/destroy (via sync hook)
2. Every 5 minutes (periodic save from daemon)
3. On daemon shutdown

### What Gets Saved

- Session names
- Window/pane layouts
- Working directories
- Running commands (configurable)
- Pane contents (scrollback history)

## Database Schema

```sql
CREATE TABLE sessions (
  slug TEXT PRIMARY KEY,
  harness_type TEXT NOT NULL DEFAULT 'claude-code',
  working_directory TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  initial_prompt TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

The `slug` is the primary key and matches the tmux session suffix (`agent_{slug}`).

## Handling Edge Cases

### Session Closed Hook Limitation

The `session-closed` hook in tmux cannot access the session name because it fires
_after_ the session data is destroyed. The sync script handles this by doing a full
reconciliation - it marks any sessions in the DB that don't exist in tmux as stopped.

### Daemon Not Running

If the daemon is not running when a tmux hook fires, the sync script runs independently
(it uses `better-sqlite3` directly, not the daemon's DB connection). The database
will still be updated.

### Orphaned Sessions

If sessions exist in tmux but not in SQLite (e.g., after a fresh DB), the sync script
creates DB records for them.

## Testing

The sync script can be tested in isolation:

```bash
# Run directly
tsx apps/daemon/scripts/sync-sessions.ts

# With verbose output
VERBOSE=1 tsx apps/daemon/scripts/sync-sessions.ts

# With custom DB path
DATABASE_PATH=/tmp/test.sqlite tsx apps/daemon/scripts/sync-sessions.ts
```
