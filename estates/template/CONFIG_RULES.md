# Context Rules System Documentation

## Overview

The Context Rules system allows you to define conditional prompts, tools, and other context that should be applied to agents based on various runtime conditions. This enables dynamic behavior modification without hardcoding logic into the agent itself.

## Core Concepts

### Context Rules

A context rule defines a set of context (prompts, tools, descriptions) that should be applied when certain conditions are met. Each rule has:

- **`key`**: Unique identifier for the rule
- **`prompt`**: Text content to be added to the agent's system prompt
- **`tools`**: Array of tools to make available to the agent
- **`description`**: Optional human-readable description
- **`match`**: Conditions that determine when this rule should apply

### Matchers

Matchers define the conditions under which a context rule should be applied. There are several types of matchers:

#### Basic Matchers

```typescript
// Always applies (useful for default behavior)
matchers.always();

// Never applies (useful for disabling inherited rules)
matchers.never();

// JSONata expression evaluation
matchers.jsonata("agentCoreState.paused = true");
```

#### Agent State Matchers

```typescript
// Match specific agent class
matchers.forAgentClass("SlackAgent");

// Check if agent has a specific label
matchers.hasLabel("GMAIL");

// Check sandbox status
matchers.sandboxStatus("attached");

// Match Slack channel
matchers.slackChannel("general"); // matches by name or ID
matchers.slackChannel("C08R1SMTZGD"); // matches by channel ID

// Check for external users in Slack channel
matchers.slackChannelHasExternalUsers(true);
```

#### Content-Based Matchers

```typescript
// Search across system prompt, input items, and runtime tools
matchers.contextContains("specific search term");

// Search for tools by name or type
matchers.hasTool("calculator");

// Search for MCP connections
matchers.hasMCPConnection("mcp.linear.app");
```

#### Participant-Based Matchers

```typescript
// Search within participant data (users in conversation)
matchers.hasParticipant("@nustom.com");
```

#### Logical Combinators

```typescript
// Combine matchers with AND logic
matchers.and(matchers.forAgentClass("SlackAgent"), matchers.hasLabel("GMAIL"));

// Combine matchers with OR logic
matchers.or(matchers.hasLabel("GMAIL"), matchers.hasLabel("GCALENDAR"));

// Negate a matcher
matchers.not(matchers.hasLabel("GMAIL"));
```

#### Time-Based Matchers

```typescript
// Match specific days of the week
matchers.timeWindow({
  weekdays: ["MO", "WE", "FR"], // Monday, Wednesday, Friday
});

// Match specific months
matchers.timeWindow({
  months: [1, 6, 12], // January, June, December
});

// Match time of day (24-hour format)
matchers.timeWindow({
  timeOfDay: { start: "09:00", end: "17:00" },
});

// Cross-midnight time windows
matchers.timeWindow({
  timeOfDay: { start: "22:00", end: "06:00" }, // 10 PM to 6 AM
});

// Exact date/time match
matchers.timeWindow({
  exact: { month: 12, day: 25, hour: 9, minute: 0 },
});

// Combine time conditions
matchers.timeWindow({
  weekdays: ["MO", "TU", "WE", "TH", "FR"],
  timeOfDay: { start: "09:00", end: "17:00" },
});

// With custom timezone
matchers.timeWindow({
  weekdays: ["MO", "FR"],
  tz: "America/New_York",
});
```

## JSONata Expressions

JSONata is a powerful query and transformation language used for complex matching conditions. The expression has access to the agent's runtime state:

### Available Context Variables

- `agentCoreState`: The agent's current state
- `durableObjectClassName`: The class name of the agent (e.g., "SlackAgent")
- `participants`: Information about conversation participants
- `slackChannelId`: Current Slack channel ID
- `slackChannel`: Current Slack channel information
- `systemPrompt`: Current system prompt
- `inputItems`: Current conversation items
- `ephemeralPromptFragments`: Temporary prompt additions
- `runtimeTools`: Available tools
- `mcpConnections`: Connected MCP servers
- `metadata`: Agent metadata (labels, sandbox status, etc.)

### Common JSONata Patterns

```javascript
// Check boolean properties
"agentCoreState.paused = true";

// Check if property exists
"$exists(agentCoreState.modelOpts.model)";

// String operations
"$contains(agentCoreState.systemPrompt, 'helpful assistant')";

// Array operations
"'GMAIL' in agentCoreState.metadata.labels";

// Numeric comparisons
"agentCoreState.modelOpts.temperature > 0.5";

// Complex conditions
"agentCoreState.slackChannelId = 'C08R1SMTZGD' or agentCoreState.slackChannel.name = 'general'";

// Nested property access
"agentCoreState.modelOpts.model = 'gpt-4o-mini'";

// Count operations
"$count(agentCoreState.mcpConnections.*[serverUrl = 'https://mcp.linear.app/mcp']) > 0";
```

### Shorthand Notation

For convenience, you can omit the `agentCoreState.` prefix in many cases:

```javascript
// These are equivalent:
matchers.jsonata("agentCoreState.paused = true");
matchers.jsonata("paused = true"); // shorthand when accessing agentCoreState properties
```

## Defining Rules in Code

### Basic Rule Definition

```typescript
import { defineRule, matchers } from "@iterate-com/sdk";

const myRule = defineRule({
  key: "my-custom-rule",
  prompt: "You are a helpful assistant with special abilities.",
  match: matchers.forAgentClass("SlackAgent"),
  tools: [
    /* array of tool definitions */
  ],
  description: "Custom rule for enhanced assistance",
});
```

### Complex Matching Logic

```typescript
const complexRule = defineRule({
  key: "gmail-user-rule",
  prompt: "You have access to Gmail tools...",
  match: matchers.and(
    matchers.forAgentClass("SlackAgent"),
    matchers.hasLabel("GMAIL"),
    matchers.not(matchers.slackChannelHasExternalUsers(true)),
  ),
  tools: [gmailTools],
  description: "Gmail functionality for internal users only",
});
```

### Time-Based Rules

```typescript
const businessHoursRule = defineRule({
  key: "business-hours-support",
  prompt: "You are available during business hours...",
  match: matchers.and(
    matchers.timeWindow({
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      timeOfDay: { start: "09:00", end: "17:00" },
    }),
    matchers.forAgentClass("SlackAgent"),
  ),
  description: "Business hours support rule",
});
```

## File-Based Rule Definition

You can define rules in markdown files with YAML front matter, making it easy to manage complex prompt content:

### Basic Markdown Rule

```markdown
---
key: my-prompt-rule
match: hasMCPConnection("mcp.notion.com")
description: Rule for when Notion integration is connected
---

# Notion Integration Instructions

When Notion integration is available:

• Use bullet points (•) instead of hyphens (-) for search results
• Format links as inline Slack links: <URL|descriptive text>
• For Notion pages, use concise link text like "open" or the page title
• Show when results were last updated (in italics)
• Example: "• Meeting notes (updated yesterday): <URL|open>"
• Never show raw Notion URLs - always wrap them in Slack link format
```

### Complex Front Matter

```markdown
---
key: conditional-tools
match:
  type: and
  matchers:
    - type: forAgentClass
      className: SlackAgent
    - type: hasLabel
      label: GMAIL
    - type: jsonata
      expression: $count(agentCoreState.mcpConnections) > 0
tools:
  - name: sendGmail
    description: Send emails via Gmail
  - name: listGmailMessages
    description: List Gmail messages
---

# Gmail Integration Instructions

When Gmail tools are available:

- Use sendGmail for composing and sending emails
- Use listGmailMessages with appropriate filters
- Always respect user privacy
- Use proper email formatting
```

## Loading Rules from Files

Use `contextRulesFromFiles()` to automatically load rules from markdown files:

```typescript
import { defineConfig, defaultContextRules, contextRulesFromFiles } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    ...defaultContextRules, // the iterate team's recommended context rules - feel free to add/remove/edit!
    // Load all .md files from rules directory
    ...contextRulesFromFiles("rules/**/*.md", { cwd: import.meta.dirname }),

    // Add programmatic rules
    myCustomRule,
    businessHoursRule,
  ],
});
```

## Rule Evaluation

### Evaluation Process

1. **Collection**: All applicable rules are collected based on their match conditions
2. **Deduplication**: Rules with duplicate keys are filtered (last one wins)
3. **Merging**: Prompts and tools from matching rules are combined
4. **Application**: The merged context is applied to the agent's system prompt and available tools

### Evaluation Context

When a rule's match condition is evaluated, it has access to:

- Current agent state (`agentCoreState`)
- Durable object class name (`durableObjectClassName`)
- Conversation participants (`participants`)
- Slack channel information (`slackChannelId`, `slackChannel`)
- Connected MCP servers (`mcpConnections`)
- Agent metadata (`metadata`)

### Rule Precedence

Rules are evaluated in the order they appear in the configuration. When rules have conflicting tools or prompts:

- **Tools**: All tools from matching rules are combined
- **Prompts**: Prompts are concatenated in rule definition order
- **Key Conflicts**: Later rules with the same key override earlier ones

## Best Practices

### 1. Use Descriptive Keys

```typescript
// Good
key: "gmail-internal-users-only";

// Avoid
key: "rule-1";
```

### 2. Keep Conditions Simple

```typescript
// Prefer simple conditions
match: matchers.hasLabel("GMAIL");

// Over complex expressions when possible
match: matchers.jsonata(
  "agentCoreState.metadata.labels and 'GMAIL' in agentCoreState.metadata.labels",
);
```

### 3. Use Logical Combinators

```typescript
// Combine simple conditions
match: matchers.and(matchers.forAgentClass("SlackAgent"), matchers.hasLabel("GMAIL"));

// Instead of complex JSONata
match: matchers.jsonata(
  "durableObjectClassName = 'SlackAgent' and 'GMAIL' in agentCoreState.metadata.labels",
);
```

### 4. Document Complex Rules

```markdown
---
key: complex-integration-rule
match:
  type: and
  matchers:
    - type: forAgentClass
      className: SlackAgent
    - type: hasMCPConnection
      searchString: mcp.notion.com
description: Complex rule requiring SlackAgent class and Notion MCP connection
---

# Complex Integration Instructions

This rule applies when:

- The agent is a SlackAgent instance
- Notion MCP server is connected
- Provides specialized Notion integration guidance
```

### 5. Use Context Matching Effectively

```typescript
// Match when users mention specific topics
match: matchers.contextContains("help with calendar");

// Match when users express urgency
match: matchers.contextContains("urgent");

// Match when users mention specific tools
match: matchers.or(
  matchers.contextContains("gmail"),
  matchers.contextContains("calendar"),
  matchers.contextContains("notion"),
);
```

## Common Patterns

### Conversation-Based Rules

```typescript
const helpRequestRule = defineRule({
  key: "help-request-response",
  prompt: dedent`
    When users ask for help or mention problems:

    • Acknowledge their request immediately
    • Ask clarifying questions if needed
    • Offer to help solve their specific issue
    • Be proactive about finding solutions

    Examples of what triggers this:
    • "I need help with..."
    • "Having trouble with..."
    • "Can you assist with..."
    • "Something's not working..."
  `,
  match: matchers.contextContains("help"),
  description: "Enhanced support when users need assistance",
});

const loveIterateRule = defineRule({
  key: "love-iterate-response",
  prompt: dedent`
    When users express love or appreciation for iterate:

    • Respond with genuine warmth and appreciation
    • Share a fun fact about iterate's capabilities
    • Ask how you can help them further today
    • Keep the tone friendly and engaging

    Example responses:
    • "Thanks! I'm glad you enjoy working with me! 😊"
    • "I love helping teams get more done! What's one thing I can help you with right now?"
    • "That's so kind! iterate is all about making work more efficient and enjoyable."

    What triggers this rule:
    • "I love iterate"
    • "iterate is great"
    • "thanks iterate"
    • "you're awesome iterate"
  `,
  match: matchers.or(
    matchers.contextContains("love iterate"),
    matchers.contextContains("love you iterate"),
    matchers.contextContains("thanks iterate"),
    matchers.contextContains("great iterate"),
  ),
  description: "Special responses when users express love for iterate",
});
```

### Capability-Based Rules

```typescript
const advancedUserRule = defineRule({
  key: "advanced-user-capabilities",
  prompt:
    "You have access to advanced tools. Use them when appropriate but explain what you're doing.",
  tools: [advancedTools],
  match: matchers.hasLabel("ADVANCED_USER"),
  description: "Enhanced capabilities for advanced users",
});
```

### Integration-Specific Rules

```typescript
const linearIntegrationRule = defineRule({
  key: "linear-integration-active",
  prompt:
    "Linear integration is active. You can create issues, update status, and link conversations.",
  match: matchers.hasMCPConnection("mcp.linear.app"),
  description: "Instructions for when Linear MCP is connected",
});
```

## Debugging and Testing

### Testing Matchers

```typescript
import { evaluateContextRuleMatchers } from "./context.ts";

// Test a matcher against mock state
const mockState = {
  agentCoreState: {
    paused: true,
    metadata: { labels: ["GMAIL"] },
  },
  durableObjectClassName: "SlackAgent",
};

const result = evaluateContextRuleMatchers({
  contextRule: {
    match: matchers.and(matchers.forAgentClass("SlackAgent"), matchers.hasLabel("GMAIL")),
  },
  matchAgainst: mockState,
});

console.log("Matcher result:", result); // true or false
```
