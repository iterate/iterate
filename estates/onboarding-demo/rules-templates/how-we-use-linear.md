---
slug: how-we-use-linear
match: hasMCPConnection("mcp.linear.app")
---

# How We Use Linear

Whenever you're asked to do something in Linear, note the following:

## Workspace Structure

### Team Configuration

- We have a single team called 'iterate' in our workspace
- All work is organized within this single team structure

### Projects

- We do NOT use Linear projects for regular work tracking
- EXCEPTION: We maintain one project called 'Feature Ideas' to collect and organize feature concepts for future consideration

### Area Labels

We use one 'Area' label group with three categories:

- Agents & Apps Engineering (Misha): All engineering work related to agents, apps, integrations, and middleware
- Platform / Infra (Nick B): All platform and infrastructure engineering tasks
- Everything else (Jonas): All other work not covered by other areas

### Bug Labels

Use the 'bug' label to mark all bug-related issues

### Cycle Management

We use cycles for sprint planning and work organization

## Creating Issues

### Two Types of Issues

1. Regular Work Issues: Day-to-day tasks, bugs, engineering work
2. Feature Ideas: Future concepts and ideas for consideration

### Regular Work Issues

#### Default Settings

- Current cycle assignment
- Status: 'Triage'
- No project assigned

#### Required Labels

- Appropriate Area label (Agents & Apps Engineering, Platform/Infra, or Everything else)
- 'bug' label if the issue reports a defect or problem

#### Priority Settings

- Default priority: No priority set (let team triage)
- Bug issues: Set priority to 'High'

### Feature Ideas

#### Special Settings

- Assign to 'Feature Ideas' project
- NO cycle assignment
- Status: 'Triage'

#### Purpose

- Used to collect and organize feature concepts for future consideration
- Not intended for immediate development work

### General Guidelines

- Ensure issue title and description are clear and well-defined
- Do not make up descriptions or details
- ALWAYS include the slack thread link in the 'links' Issue property in Linear
- Only deviate from defaults when it's a feature idea, or a user explicitly requests different settings

## Updating Tickets

### Pre-Update Process

Always draft proposed changes first and wait for user confirmation before proceeding

### Information Gathering

Ask user if they want to check GitHub for recent updates to inform ticket status changes
If user agrees, check recent PRs from the last week (7 days) for ticket references:

- Look for Linear ticket IDs in PR titles (e.g., CS-123, OS-456)
- Check PR descriptions for 'Fixes #ticket-id' or 'Closes #ticket-id'
- Review commit messages for ticket references
- Look for Linear integration comments in PRs

### Status Updates Based on PR State

- Open PR → Move ticket to 'In Progress' if not already
- Merged PR → Move ticket to 'Done'
- Closed (not merged) PR → Evaluate if ticket should remain open or be cancelled

### Additional Actions

- Add PR links to Linear tickets for traceability
- Update ticket descriptions with implementation details when relevant
- Check if related tickets also need updates
