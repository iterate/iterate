
# Database tables

Auth
- User
- Accounts
- Sessions
- Verifications
- Organization
- OrganizationUserMembership
- InstanceAccountsPermissions

Our domain model
- Events (stores slack webhook events)
  - OutboxEvent should just be a kind of event
- Instance (formerly known as estate)
- Machine
- Repo


UI View
- When logged out, show login page with Slack and google login buttons
- Keep main logged in layout
  - Sidebar
    - Keep the user menuat bottom and org menu at top and general layout etc
  - Pages
    - Home page
        - Explain how to use the product
        - Delete agents listand offline viewer and start slack convo
    
    - Organization Settings
        - Members (but no external slack users)
        - Settings (just change org name)
        - Connectors
            - Slack
            - Google
            - (Delete the MCP stuff and github)
    - For each instance
        - Machines (new)
            - Simple list of machines with status
            - Button to make new machine
        - Agents (new)
            - Leave empty for now

    - Admin tools
        - just keep trpc tools and impersonation


# Infra / code structure view

- Packages
    - One package and two worker deployments in one alchemy file

- Workers 
    - apps/os/src (big)
        - vite app
        - tanstack start
    - apps/os/src/edge - edge router (small)
        - not a vite app
        - connects to planetscale postgres and proxies to sandbox

- Durable objects
    - query invalidator exported from os app

- Workflows
    - When somebody signs up
        - If no organisation
            - CreateOrganization workflow
        - if no instance in organisation
            - CreateInstance workflow
        - if no machine in instance
            - CreateMachine workflow
    - When somebody clicks "Create machine" in UI
        - CreateMachine workflow


# High level plan

- [] Scaffold new tanstack start app with worker deployment etc
- [] Add database tables
- [] Steal authentication better_auth stuff from previous version


# Definitely out of scope for now
- No billing
- No MCP right now (unless it's just providing a static env var that a CLI agent picks up)
- Files system
- Dynamic Client stuff in better auth
- SlackConnect stuff - just have a slackbot is all
    - Slack channel estate override etc
- Delete iterate config table
- Builds
- ProviderUserMapping
