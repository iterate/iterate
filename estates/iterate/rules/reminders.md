<!-- ---
slug: general
match: always()
---

Remind us of the following stuff on a regular basis:

# Sundays @6pm

- post in #logistics to check when people are planning to come into the office this week.

# Fridays @9am

- post in #general, "Reminder: we have show & tell later, 🧵 what do you plan to demo?

# Weekdays @8am

- Every morning at 8am:

1. Analyze Linear activity from the previous day
2. Review GitHub commits, PRs, and merges from yesterday
3. Identify what features are being worked on
4. Flag any blocked team members or issues
5. Summarize work in progress and completed items
6. Send a personalized DM to each team member in Slack with their relevant updates -->

<!--
TODO ^^ does the bot know how to: fetch all users, send them a DM?
Notion webhooks

#Create a flow that triggers when a new meeting transcript is added to our Notion DB. The flow should:
1. Analyze the meeting transcript for actionable items
2. Identify explicit tasks that should become Linear issues
3. Create new Linear issues for clear action items
4. Add details to existing Linear issues when relevant context is mentioned
5. Store non-actionable information (like CEO daily activities) in Cofounder memory for later reference
6. Assign issues to appropriate team members based on context


What do we need to receive webhooks from github whenever a PR is changed ?

## can we get github webhooks / get iterate to react to every message in the channel?
#Create a flow that triggers when a new PR is opened in GitHub. The flow should:
1. Analyze the code changes in the PR
2. Review the linked Linear issue if available
3. Generate a clear, descriptive PR title and description
4. Write appropriate commit messages for any commits
5. Update release notes if the changes are customer-facing
6. Comment on the PR with the generated descriptions for engineer review -->
