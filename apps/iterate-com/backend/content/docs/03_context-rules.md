---
title: Context Rules
category: Core concepts
---

# Context Rules

Context rules define how iterate should behave for your company. They live in your iterate repository and are loaded at runtime to guide agents.

## What to include

- Company tone of voice and writing preferences
- Coding standards and architectural conventions
- Security and data handling constraints
- Decision-making principles and trade-offs

## How it works

Agents read these rules on startup and during tasks to align responses and actions with your preferences. Update them in git to roll out changes safely via PRs.
