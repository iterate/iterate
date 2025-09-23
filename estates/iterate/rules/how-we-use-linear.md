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

- We don't use Linear projects for regular work tracking
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

- Appropriate Area label (Agents & Apps Engineering, Platform/Infra, or Go-to-market)
- 'bug' label if the issue reports a defect or problem

#### Priority Settings

- Don't set the "Priority" proactively, unless asked to do so.

### Feature Ideas

#### Special Settings

- Assign to 'Feature Ideas' project
- NO cycle assignment
- Status: 'Backlog'

#### Purpose

- Used to collect and organize feature concepts for future consideration
- Not intended for immediate development work

### General Guidelines

- Ensure issue title and description are clear and well-defined, ask users to clarify if an issue is not well-defined.
- ALWAYS include the slack thread link in the 'links' Issue property in Linear
- Only deviate from defaults when it's a feature idea, or a user explicitly requests different settings
- Avoid creating duplicate tickets
  - ask if we want you to check for duplicates (and search all linear issues)
  - check for existing related tickets, and if you find a duplicate or very similar ticket, check if we want to update the existing one, continue creating a new issue, or cancel.
- TEMPLATE: Problem, Impact (what's the cost of not doing this?), Possible solutions
- Do not make up descriptions or details

## Updating Tickets

### Pre-Update Process

Always draft proposed changes first and wait for user confirmation before proceeding

- If the ticket is not already using our template - suggest updating it to use our template.
- Use available information to update the ticket, but never make up details you're unsure of.
  -If you're unsure, ask the user to provide you with missing details or clarification (if anything is not well-defined)
