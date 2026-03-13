---
name: code-review
description: Review a selected set of code changes against provided rules, check rule-by-rule compliance, propose refactors and solutions, and write a consolidated markdown report. Use when the user asks for a code review, rules compliance review, or refactor recommendations for a change set.
publish: false
---

# Code Review

You need to 1) check the compliance of a set of code changes with the given rules and 2) propose refactors and solutions for them.

The rules are in jonasland/RULES.md

## Workflow

First, if the user hasn't already told you, you must find out which changes. Provide options to user:

1. compared to parent branch
2. unstaged changes
3. last commit
4. something else

Optionally ask the user if they want to limit to only changes in some folder.

Second, in parallel with subagents do a map / reduce:

1. Check adherence to each of the rules.
   - Look at each rule individually.
   - An issue must be specifically quoted with offending code and why it's a violation.
2. Produce suggestions for fixes / refactors.
   - Each subagent must produce multiple different options for how to fix each issue, alongside a recommendation and reasoning.

Then take all the findings and combine them into a high level report. Write it to a markdown file in the repo called `code-review-[slug].md` and pick a slug that's appropriate.

Leave a section `# Plan (TODO)` empty at the end.

Then ask many detailed questions of the user with detailed options and recommendations. Don't use the question ask tool.

Then fill in the `# Plan` section and ask for confirmation once more, before remediating the findings.

# Style

- Always give labeled options and propose the recommended / default one
- When asking multiple questions, number them. So the user can say 1a 2b 3b 4c etc
