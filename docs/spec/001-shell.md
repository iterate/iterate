# Shell Spec

We are building a system that lets users run coding agents in cloud sandboxes.

Users can belong to one or more organizations, and organizations can have zero or more projects.

Projects tie together a git repository, third-party connections (project-wide like Slack or user-scoped like Gmail), environment variables, and API access tokens.

This document describes the requirments for the "shell" of this app in a technology agnostic way;

the sandbox and agent runtime will be added later, but the full database model should be set up now

---

## Concepts and Scope

### What we are building

- A product shell for teams to manage projects that run coding agents in cloud sandboxes.
- A project is the primary domain entity. Projects map one-to-one with a repo and own machines, connections, env vars, access tokens, and events.
- OAuth integrations exist at two scopes:
  - **Project-scoped connections**: Slack workspace connected to a project.
  - **User-scoped connections**: Gmail via Google OAuth connected per user within a project.
  - A single ProjectConnection table should support both scopes via a scope field and nullable userId.
- Login mechanisms are twofold: email OTP and Google OAuth login. Google OAuth login is a separate concept from project connections and should be implemented separately from Gmail connections.
- In non-production (dev, test, staging), any email address containing `+*test` (including `+clerk_test`) skips sending and accepts confirmation code `424242`.
- Users have roles within each organization and also a platform-wide role (`admin` or `user`). Platform admins have a user impersonation UI available from the admin area.

### What we are not building here

- Billing/payments
- AI/agent features (placeholders only)
- Container orchestration
- Complex RBAC beyond the 3-role org model
- Real-time collaboration

### Implementation philosophy

Keep everything minimal. No boilerplate copy or unnecessary UI elements. This is a functioning skeleton with few lines of code and few complications. Prioritize working functionality over polish.

---

## Data Model (PostgreSQL)

Primary keys use prefixed, quasi-sortable TypeID-style IDs (e.g., `prj_01h2xcejqtf2nbrexx3vqjhp41`). Prefixes are per table. All tables include `created_at` and `updated_at` timestamps.

### Auth Tables

```sql
-- Core user record
CREATE TABLE "user" (
    id TEXT PRIMARY KEY,                           -- prefix: usr_
    email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    name TEXT NOT NULL,
    image TEXT,
    role TEXT NOT NULL DEFAULT 'user',             -- platform role: 'admin' | 'user'
    banned BOOLEAN,
    ban_reason TEXT,
    ban_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- OAuth accounts linked to users (for Google OAuth login)
CREATE TABLE account (
    id TEXT PRIMARY KEY,                           -- prefix: acc_
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,                     -- e.g., 'google'
    account_id TEXT NOT NULL,                      -- provider's user ID
    access_token TEXT,
    refresh_token TEXT,
    id_token TEXT,
    access_token_expires_at TIMESTAMPTZ,
    refresh_token_expires_at TIMESTAMPTZ,
    scope TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Active user sessions
CREATE TABLE session (
    id TEXT PRIMARY KEY,                           -- prefix: ses_
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    impersonated_by TEXT REFERENCES "user"(id) ON DELETE CASCADE,  -- admin impersonation
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tokens for email OTP and other verification flows
CREATE TABLE verification (
    id TEXT PRIMARY KEY,                           -- prefix: ver_
    identifier TEXT NOT NULL,                      -- email address
    value TEXT NOT NULL,                           -- the OTP code
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Domain Tables

```sql
-- Organizations group users; eventually attach billing
CREATE TABLE organization (
    id TEXT PRIMARY KEY,                           -- prefix: org_
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,                     -- URL-safe, e.g., 'acme-corp-a1b2c3'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organization membership with three-role model
CREATE TABLE organization_membership (
    id TEXT PRIMARY KEY,                           -- prefix: mbr_
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',           -- 'owner' | 'admin' | 'member'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

-- Project: the primary domain entity (one-to-one with repo)
CREATE TABLE project (
    id TEXT PRIMARY KEY,                           -- prefix: prj_
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,                            -- unique within org, e.g., 'backend-api-x1y2'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);
CREATE INDEX idx_project_organization ON project(organization_id);

-- Git repository linked to a project (one-to-one)
CREATE TABLE repo (
    id TEXT PRIMARY KEY,                           -- prefix: repo_
    project_id TEXT NOT NULL UNIQUE REFERENCES project(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                        -- 'github' | 'gitlab' | etc.
    owner TEXT NOT NULL,                           -- repo owner/org name
    name TEXT NOT NULL,                            -- repo name
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cloud sandbox machines for a project
CREATE TABLE machine (
    id TEXT PRIMARY KEY,                           -- prefix: mch_
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,                            -- machine type/size
    state TEXT NOT NULL DEFAULT 'started',         -- 'started' | 'archived'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_machine_project ON machine(project_id);

-- Encrypted environment variables for a project
CREATE TABLE project_env_var (
    id TEXT PRIMARY KEY,                           -- prefix: env_
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,                 -- encrypted with per-project key
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, key)
);
CREATE INDEX idx_project_env_var_project ON project_env_var(project_id);

-- API access tokens for a project
CREATE TABLE project_access_token (
    id TEXT PRIMARY KEY,                           -- prefix: pat_
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,                      -- hashed token for verification
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_project_access_token_project ON project_access_token(project_id);

-- OAuth connections (project-scoped like Slack, or user-scoped like Gmail)
CREATE TABLE project_connection (
    id TEXT PRIMARY KEY,                           -- prefix: conn_
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                        -- 'slack' | 'google' | etc.
    external_id TEXT NOT NULL,                     -- provider's ID (e.g., Slack team ID)
    scope TEXT NOT NULL,                           -- 'project' | 'user'
    user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,  -- required if scope='user'
    provider_data JSONB NOT NULL DEFAULT '{}',     -- tokens, metadata, etc.
    scopes TEXT,                                   -- OAuth scopes granted
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT check_user_scope CHECK (
        (scope = 'project' AND user_id IS NULL) OR
        (scope = 'user' AND user_id IS NOT NULL)
    )
);
CREATE UNIQUE INDEX idx_project_connection_provider_external ON project_connection(provider, external_id);
CREATE INDEX idx_project_connection_project ON project_connection(project_id);

-- Events table for webhooks and future event bus
CREATE TABLE event (
    id TEXT PRIMARY KEY,                           -- prefix: evt_
    project_id TEXT REFERENCES project(id) ON DELETE CASCADE,  -- nullable for unrecognized webhooks
    type TEXT NOT NULL,                            -- e.g., 'slack.webhook', 'github.push'
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_project ON event(project_id);
CREATE INDEX idx_event_type ON event(type);
CREATE INDEX idx_event_created ON event(created_at);
```

### Key Design Decisions

1. **Slugs for URLs**: Organizations and projects have URL-safe slugs generated from name + random suffix (e.g., `my-project-a1b2c3`). Routes use slugs, not IDs.
2. **Three-role org model**: Only `owner`, `admin`, `member` for org membership.
3. **Connections are explicit**: Every OAuth integration is a connection. Some are project-scoped, some are user-scoped. Enforced via CHECK constraint.
4. **Events are project-scoped**: Events are stored in a single table with `project_id` for partitioning; nullable for unrecognized webhooks.
5. **Provider lookup via external_id**: Webhook receivers map provider identifiers (e.g., Slack team ID) to `project_id` via indexed `(provider, external_id)`.
6. **Provider extensibility**: OAuth providers and scopes should be structured so adding new providers or adjusting scopes is straightforward.

---

## UI Structure

### Route Hierarchy

```
/login                          # Public - Email OTP + Google OAuth + Dev mode login (non-prod only)
/user/settings                  # User settings (requires auth)
/                               # Smart redirect (see below) or to /login if logged out
/new-organization               # Create organization form

/orgs/:orgSlug/                 # Organization layout (requires auth + membership)
  /                             # Redirect to first project or /projects/new if none
  /settings                     # Edit organization (accessed via gear icon in sidebar)
  /team                         # Members list; add members by email
  /projects/new                 # Create new project form

  /projects/:projectSlug/       # Project layout
    /                           # Access tokens
    /machines                   # Machine list
    /repo                       # Repo details (from database)
    /connectors                 # OAuth integrations for the project
    /env-vars                   # Environment variables
    /settings                   # Rename/delete project, manage repo
    /agents                     # Placeholder for future agent functionality

/admin/                         # Platform admin only (user.role === "admin")
  /                             # Dashboard - user/org counts
  /trpc-tools                   # API explorer/debugger
  /session-info                 # Debug current session
```

**Smart redirect from `/`:**

1. If user has orgs with projects → redirect to first project of first org
2. If user has orgs but no projects → redirect to `/orgs/:orgSlug/projects/new`
3. If user has no orgs → redirect to `/new-organization`

### Layout Components

1. **Authenticated layout**
   - Sidebar with:
     - Organization/project switcher dropdown at top:
       - Lists all orgs the user belongs to
       - Each org row has a gear icon for org settings
       - Under each org, shows that org's projects as sub-items
       - "Add Project" button under each org's project list
     - If single project in current org: project name shown in sidebar header, project-specific nav links below
     - If multiple projects: select project from dropdown, then project-specific nav appears
     - Project-specific nav: Access Tokens, Machines, Repo, Connectors, Env Vars, Settings, Agents
     - Team link (org-level)
     - User menu with logout and admin link (if applicable)

2. **Empty states**
   - No machines → "Create Machine" CTA

3. **Team page**
   - Member list with avatar, name, email, role
   - Role dropdown for owner/admin to change roles
   - Add member by email input (user must already exist in system)

4. **Repo page**
   - Display repo details from database (provider, owner, name, default branch)

5. **Project settings page**
   - Rename project
   - Delete project
   - Manage linked repo

---

## Backend Structure

- Split backend responsibilities into a skinny edge router and the main application. In the future these will be deployed as two separate applications, so lay the groundwork now.
- The edge router should expose a dedicated namespace `/edge/*` for third-party webhooks.
- Example: `/edge/slack` receives Slack webhooks and routes them by looking up the Slack team ID in `ProjectConnection` (`provider=slack`, `externalId=teamId`).
- The edge router should remain minimal. For now it can store events directly and skip signature verification; verification can be added later.
- If a webhook arrives with an unknown team ID, store the event with `projectId=null` and log a warning.

---

## User Flows

### 1. Authentication

```
User chooses email OTP or Google OAuth
  → Email OTP: enter email, receive code, submit code
  → Google OAuth: redirected to provider, returns with auth code
  → Backend verifies and exchanges tokens/codes
  → User record created/updated
  → Session created
  → Redirect to / (smart redirect to first project, or new-project/new-org form as needed)
```

Dev mode login (non-prod only)

```
User clicks "Dev mode login"
  → Modal prompts for email address
  → Backend logs in as that user (create if missing)
  → Redirect to / (smart redirect)
```

Non-prod email OTP behavior

```
If email contains +*test (including +clerk_test)
  → Skip sending email
  → Accept confirmation code 424242
```

### 2. First-time user setup

```
New user signs in
  → No organizations exist
  → Smart redirect sends them to /new-organization
  → User enters organization name
  → Organization created with auto-generated slug
  → User added as owner
  → Smart redirect sends them to /orgs/:orgSlug/projects/new (no projects yet)
  → User creates first project
  → Redirect to /orgs/:orgSlug/projects/:projectSlug/
```

### 3. Project creation

```
Any org member visits /orgs/:orgSlug/projects/new (or clicks "Add Project")
  → Enters project name
  → Project created with auto-generated slug
  → Dummy repo entry created in repo table (placeholder for future repo creation)
  → Redirect to /orgs/:orgSlug/projects/:projectSlug/
```

### 4. Organization management

```
Owner/Admin visits /orgs/:orgSlug/team
  → Sees member list with roles
  → Can change roles (owner can transfer ownership)
  → Can remove members
  → Can add member by email (user must already exist in system)
```

### 5. Machine lifecycle

```
User clicks "Create Machine"
  → Modal with name input and type selector
  → Submit creates machine in "started" state
  → Machine appears in list

User clicks "Archive" on a machine
  → Machine state changes to "archived"
  → Still visible but greyed out
```

### 6. Slack integration (project connection example)

```
Admin visits /orgs/:orgSlug/projects/:projectSlug/connectors
  → Clicks "Connect Slack"
  → Redirected to Slack OAuth (bot installation)
  → Selects workspace, approves scopes
  → Redirected back
  → ProjectConnection created with bot tokens, scope=project

Slack sends webhook event
  → Edge router resolves team ID to project via ProjectConnection (provider=slack, externalId=teamId)
  → If unknown team ID, store event with projectId=null and log a warning
  → Saves to events table with type="slack.webhook" and payload
  → (Future: routed through an event bus)
```

### 7. User connection example (Gmail)

```
User visits /orgs/:orgSlug/projects/:projectSlug/connectors
  → Clicks "Connect Gmail"
  → OAuth flow completes
  → ProjectConnection created for that user, scope=user
  → If two users belong to the same org + project, they can each have distinct Gmail connections
```

### 8. Admin impersonation

```
Platform admin visits /admin
  → Uses the impersonation panel in the admin dashboard
  → Clicks "Impersonate" on a user
  → Session updated with impersonatedBy field
  → Admin sees app as that user
  → Banner shown with "Stop Impersonating" button
  → Click to restore original session
```

---

## API Authorization Model

```
Public
  └── Authenticated (requires valid session)
        ├── Org-Scoped (validates user is member of :orgSlug)
        │     └── Org-Admin (requires owner or admin role)
        ├── Project-Scoped (validates user can access :projectSlug)
        └── Platform-Admin (requires user.role === "admin")
```

All org/project endpoints validate membership via slug lookup, not just ID.

**Project creation**: Any org member can create projects (no admin role required).

---

## Integration Points (Examples)

### Slack (Project-scoped connection)

- **Scopes**: channels:read, chat:write, users:read, reactions:read/write, files:read
- **Events**: Store raw webhook payloads in events table
- **Bot token**: Stored on the ProjectConnection

### Google OAuth (Login + user-scoped connection)

- **Scopes**: email, profile, openid (+ Gmail/Calendar for user-specific integrations)
- **Purpose**: User authentication is separate from project connections and may be implemented independently. Gmail connections are user-scoped ProjectConnections.

---

## Summary

This shell provides authentication, organizations/teams, projects, machines, env vars, access tokens, and connection infrastructure. Projects are the core domain object and map one-to-one with repos (dummy repo entries for now). OAuth integrations are modeled as connections, scoped either to projects or to users, with Slack as a project-wide connection and Gmail per user. Sign-in uses email OTP and Google OAuth, with non-prod OTP shortcuts as noted. Events are stored per project to support future event bus workflows. Any org member can create projects. Members are added by email (must already exist in system). Keep everything minimal—this is a functioning skeleton.
