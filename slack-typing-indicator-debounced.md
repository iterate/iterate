# Fix Slack Typing Indicator Oscillation with Debounced State Management

## Problem

The Slack typing indicator currently oscillates (rapidly turns on/off) during agent processing because it's directly tied to individual LLM request start/end events. Since the agent makes multiple LLM requests to compose a single response, users see the typing indicator flicker repeatedly, creating a poor user experience.

**Current implementation** (in `slack-agent.ts` lines 103-132):

- Starts typing on `CORE:LLM_REQUEST_START`
- Stops typing on `CORE:LLM_REQUEST_END` or `CORE:LLM_REQUEST_CANCEL`

## Solution

Implement a simple two-part solution using debouncing:

1. **Maintain typing indicator state** as reduced state that tracks what the indicator should display
2. **Debounce Slack API calls** to send status updates at most once every X milliseconds

This approach eliminates the complexity of DO alarms while providing smooth typing indicator behavior.

## Implementation Details

### 1. Add Typing Indicator State to Slack Slice

Add typing indicator state to the Slack slice where it logically belongs:

```typescript
// In slack-slice.ts - update SlackSliceState interface
export interface SlackSliceState {
  slackThreadId?: string | null;
  slackChannelId?: string | null;
  botUserId?: string;
  /**
   * Current typing indicator status. When set, the typing indicator should be active.
   * When null/undefined, the typing indicator should be cleared.
   */
  typingIndicatorStatus?: string | null;
}
```

### 2. Create Debounced Slack Status Updater with Timeout

```typescript
// In slack-agent.ts
import { debounce } from "p-suite";

export class SlackAgent extends IterateAgent<SlackAgentSlices> {
  private typingTimeoutId: NodeJS.Timeout | null = null;

  // Debounced function that actually calls the Slack API
  private updateSlackStatusDebounced = debounce(
    async (status: string | null) => {
      const { slackChannelId, slackThreadId } = this.getReducedState();
      if (!slackChannelId || !slackThreadId) return;

      await this.slackAPI.assistant.threads
        .setStatus({
          channel_id: slackChannelId,
          thread_ts: slackThreadId,
          status: status || "",
        })
        .catch((error) => {
          console.error("[SlackAgent] Failed to update typing status:", error);
        });
    },
    { delay: 300 }, // Update Slack API at most once every 300ms
  );

  // Call this whenever typing indicator state should change
  private syncTypingIndicator() {
    const status = this.agentCore.state.typingIndicatorStatus;

    // Clear any existing timeout
    if (this.typingTimeoutId) {
      clearTimeout(this.typingTimeoutId);
      this.typingTimeoutId = null;
    }

    // Update the Slack API
    this.updateSlackStatusDebounced(status);

    // If we're setting a typing status, set a 15-second timeout to clear it
    if (status) {
      this.typingTimeoutId = setTimeout(() => {
        // Clear typing indicator after 15 seconds of inactivity
        this.agentCore.addEvents([
          {
            type: "SLACK:UPDATE_TYPING_STATUS",
            data: { status: null },
          },
        ]);
        // Immediately sync to clear it
        this.updateSlackStatusDebounced(null);
        this.typingTimeoutId = null;
      }, 15000);
    }
  }
}
```

### 3. Add Typing Indicator Event to Slack Slice

Add a new event type to the Slack slice for updating typing status:

```typescript
// In slack-slice.ts - add new event type

// SLACK:UPDATE_TYPING_STATUS
export const slackUpdateTypingStatusFields = {
  type: z.literal("SLACK:UPDATE_TYPING_STATUS"),
  data: z.object({
    status: z.string().nullable(),
  }),
};

export const SlackUpdateTypingStatus = z.object({
  ...agentCoreBaseEventFields,
  ...slackUpdateTypingStatusFields,
});

export const SlackUpdateTypingStatusInput = z.object({
  ...agentCoreBaseEventInputFields,
  ...slackUpdateTypingStatusFields,
});

// Update the discriminated unions
export const SlackSliceEvent = z.discriminatedUnion("type", [
  SlackWebhookEventReceived,
  SlackUpdateSliceState,
  SlackUpdateTypingStatus, // Add this
]);

export const SlackEventInput = z.discriminatedUnion("type", [
  SlackWebhookEventReceivedInput,
  SlackUpdateSliceStateInput,
  SlackUpdateTypingStatusInput, // Add this
]);

// Update the reducer to handle the new event
reduce(state, _deps, event) {
  const next = { ...state };

  switch (event.type) {
    // ... existing cases ...

    case "SLACK:UPDATE_TYPING_STATUS": {
      next.typingIndicatorStatus = event.data.status;
      break;
    }
  }

  // ... rest of reducer
}
```

### 4. Update Event Handlers

Replace the current typing indicator logic with state-based management:

```typescript
// In slack-agent.ts onEventAdded handler
protected getExtraDependencies(deps: AgentCoreDeps) {
  return {
    onEventAdded: <E, S>(payload: { event: E; reducedState: S; /* ... */ }) => {
      deps?.onEventAdded?.(payload);

      const event = payload.event as AgentCoreEvent;
      switch (event.type) {
        case "CORE:LLM_REQUEST_START":
          // Set typing state when LLM processing starts
          this.agentCore.addEvents([{
            type: "SLACK:UPDATE_TYPING_STATUS",
            data: { status: "is typing..." }
          }]);
          break;

        case "CORE:TOOL_CALL_START":
          // Also show typing during tool execution
          this.agentCore.addEvents([{
            type: "SLACK:UPDATE_TYPING_STATUS",
            data: { status: "is working..." }
          }]);
          break;

        case "CORE:LLM_REQUEST_CANCEL":
          // Clear typing on cancellation
          this.agentCore.addEvents([{
            type: "SLACK:UPDATE_TYPING_STATUS",
            data: { status: null }
          }]);
          break;

        // Remove CORE:LLM_REQUEST_END case - no longer stops typing
      }

      // Sync typing indicator after any state changes
      this.syncTypingIndicator();
    },
    // ... other deps
  };
}
```

### 5. Handle Object Boot from Hibernation

Set the typing indicator when the object first boots and LLM processing starts:

```typescript
// In onSlackWebhookEventReceived method
async onSlackWebhookEventReceived(slackWebhookPayload: SlackWebhookPayload) {
  // ... existing webhook processing ...

  // After addEvents call, check if LLM was triggered
  if (this.agentCore.state.triggerLLMRequest) {
    // Object just woke up and will start processing - set typing
    this.agentCore.addEvents([{
      type: "SLACK:UPDATE_TYPING_STATUS",
      data: { status: "is typing..." }
    }]);
  }

  // Sync the indicator
  this.syncTypingIndicator();

  return { success: true };
}
```

### 6. Clear Typing on Turn End

```typescript
// In sendSlackMessage method
async sendSlackMessage(input: Inputs["sendSlackMessage"]) {
  // ... existing message sending logic ...

  if (endTurn) {
    // Clear typing when ending turn
    this.agentCore.addEvents([{
      type: "SLACK:UPDATE_TYPING_STATUS",
      data: { status: null }
    }]);
    this.syncTypingIndicator();
  }

  // ... rest of method
}
```

### 7. Update Sync Method to Use Slack State

```typescript
// In slack-agent.ts - update the sync method
private syncTypingIndicator() {
  const status = this.agentCore.state.typingIndicatorStatus;
  this.updateSlackStatusDebounced(status);
}
```

## Benefits of This Approach

- **Simple and reliable**: Uses simple timeout mechanism instead of complex DO alarms
- **Debounced API calls**: Slack API called at most once every 300ms regardless of state changes
- **Auto-cleanup**: 15-second timeout ensures typing indicator never gets stuck
- **Activity-aware**: Each new activity resets the timeout, extending typing duration appropriately
- **State-driven**: Single source of truth for typing indicator status in Slack slice
- **Extensible**: Can easily update typing status from magic function args or other contexts
- **Boot-safe**: Properly handles object hibernation/wake cycles
- **No oscillation**: Debouncing prevents rapid on/off flickering

## Acceptance Criteria

- ✅ Typing indicator appears when a webhook triggers LLM processing
- ✅ Typing indicator persists across multiple LLM requests during agent processing
- ✅ Typing indicator stops when `sendSlackMessage` is called with `endTurn: true`
- ✅ Typing indicator automatically stops after 15 seconds of inactivity
- ✅ New activity resets the 15-second timeout (extends typing duration)
- ✅ No oscillation/flickering during normal operation
- ✅ Typing indicator works correctly after object hibernation/wake
- ✅ Multiple rapid state changes are debounced to single API calls
- ✅ Different typing statuses can be shown (e.g., "is typing...", "is working...")
- ✅ Timeout is properly cleaned up when typing stops manually

## Implementation Notes

- Uses `p-suite`'s `debounce` utility (already available in dependencies)
- 300ms debounce delay provides good balance of responsiveness and API efficiency
- State management through agent core enables future extensibility
- Backwards compatible - doesn't break existing typing behavior
