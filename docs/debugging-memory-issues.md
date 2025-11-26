# Debugging Memory Issues in workerd

## The Problem

You're seeing `JavaScript heap out of memory` errors in workerd (Cloudflare Workers runtime). This happens when the V8 heap exceeds available memory.

## Root Cause

The primary issue is in the agent system:

1. **Events accumulate in memory**: In `agent-core.ts`, the `_events` array grows unbounded
   - Events are loaded from SQL on initialization (`iterate-agent.ts:835-847`)
   - All events are loaded into memory via `initializeWithEvents()` (`agent-core.ts:570-620`)
   - New events are added to `_events` via `addEvents()` (`agent-core.ts:731`)
   - Events are persisted to SQL but ALSO kept in memory indefinitely

2. **Durable Objects persist state**: Since Durable Objects persist their state, the `_events` array persists across requests. If an agent instance accumulates thousands of events over time, memory usage grows unbounded.

3. **No cleanup mechanism**: There's no mechanism to limit or clean up old events from memory.

## How to Debug

### 1. Check Event Counts

Add logging to see how many events are being loaded:

```typescript
// In iterate-agent.ts, around line 827
logger.info(`[IterateAgent] Loading ${event.length} events for agent ${this.databaseRecord.durableObjectName}`);
```

### 2. Monitor Memory Usage

Add memory monitoring to see heap usage:

```typescript
// In agent-core.ts, add to initializeWithEvents
if (typeof performance !== 'undefined' && 'memory' in performance) {
  const mem = (performance as any).memory;
  logger.info(`[AgentCore] Memory: heapUsed=${Math.round(mem.usedJSHeapSize / 1024 / 1024)}MB, heapTotal=${Math.round(mem.totalJSHeapSize / 1024 / 1024)}MB`);
}
```

### 3. Check Which Agents Have Most Events

**Note**: Agent events are stored in SQLite within each Durable Object (not in Postgres), so you can't query them directly from Postgres.

However, you can:
1. Check the logs for the warnings we added - they'll show which agents are loading many events
2. Add a tRPC endpoint to query event counts from agents
3. Look at the `agent_instance` table in Postgres to see which agents exist, then check their event counts individually

### 4. Monitor workerd Memory Limits

Check if workerd has memory limits configured. In development, workerd might have default limits that are too low for long-running agents.

## Solutions

### Short-term: Add Memory Monitoring

Add logging to track memory usage and event counts so you can identify which agents are problematic.

### Medium-term: Implement Event Window

Instead of keeping all events in memory, only keep a sliding window (e.g., last 1000 events) and load older events from SQL when needed.

### Long-term: Lazy Event Loading

Don't load all events into memory on initialization. Instead:
- Only load events needed for current state computation
- Load events on-demand when `getEvents()` is called
- Keep a cache of recent events (e.g., last 100) in memory

## Immediate Actions

1. **Watch the logs**: With the logging we've added, you'll now see:
   - When agents load more than 1000 events (warning)
   - Which agents are loading events and how many
   - Warnings every 1000 events as they accumulate

2. **Restart workerd**: In development, periodically restart workerd to clear memory:
   ```bash
   # Kill the workerd process and restart your dev server
   pnpm dev
   ```

3. **Identify problematic agents**: Look for agents that are accumulating events rapidly. Common causes:
   - Agents in long-running conversations
   - Agents processing many tool calls
   - Agents receiving frequent webhook events (e.g., Slack agents)

4. **Consider workerd memory limits**: Check if workerd has memory limits configured. In development, you might need to increase limits or restart more frequently.

## What We've Added

1. **Memory warnings**: Logs when loading >1000 events
2. **Event count logging**: Logs which agents are loading how many events
3. **Accumulation warnings**: Warns every 1000 events as they accumulate in memory

## Next Steps for Fixing

The proper fix would be to implement **event windowing**:
- Only keep the last N events in memory (e.g., last 1000)
- Load older events from SQL on-demand when needed
- This requires refactoring `getEvents()` to be lazy and `_events` to be a sliding window

