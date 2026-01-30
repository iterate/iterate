---
state: draft
priority: high
size: medium
---

# Email Security: Restrict Recipients & Stage Routing

## Problem

The `iterate tool email` command can currently send emails to anyone from `@alpha.iterate.com`. This could be abused for spam/scam emails.

## Solution

### 1. Egress Proxy: Restrict Email Recipients

Add email recipient validation to the egress proxy (similar to how we handle secret injection).

**Location:** `apps/os/backend/egress-proxy/egress-proxy.ts`

**Logic:**
1. Intercept requests to `api.resend.com/emails`
2. Parse request body to extract `to` field (array of emails)
3. For each recipient, validate against allowed list:
   - Option A: Only org members (query `user` table via `organizationUserMembership`)
   - Option B: Only emails matching configured domain(s) per org
   - Option C: Configurable allowlist per project (new `projectEmailAllowlist` table or project setting)
4. Reject with 403 and clear error message if any recipient is not allowed

**Recommended:** Start with Option A (org members only) - strictest and requires no new config.

**Implementation sketch:**
```typescript
// In egress proxy, after secret resolution
if (url.hostname === 'api.resend.com' && url.pathname === '/emails') {
  const body = await request.json();
  const recipients = Array.isArray(body.to) ? body.to : [body.to];
  
  // Get org members' emails
  const orgMembers = await db.query.organizationUserMembership.findMany({
    where: eq(organizationUserMembership.organizationId, orgId),
    with: { user: { columns: { email: true } } }
  });
  const allowedEmails = new Set(orgMembers.map(m => m.user.email.toLowerCase()));
  
  for (const recipient of recipients) {
    if (!allowedEmails.has(recipient.toLowerCase())) {
      return new Response(JSON.stringify({
        error: `Recipient ${recipient} not allowed. Can only send to organization members.`
      }), { status: 403 });
    }
  }
}
```

### 2. Stage-Based From Address

**Current:** `agent@alpha.iterate.com`
**Proposed:** `{stage}@alpha.iterate.com` (e.g., `dev-mmkal@alpha.iterate.com`, `prd@alpha.iterate.com`)

**Changes:**
1. Update `apps/os/backend/orpc/router.ts`:
   ```typescript
   envVars["ITERATE_RESEND_FROM_ADDRESS"] = `${env.VITE_APP_STAGE}@alpha.iterate.com`;
   ```

2. Update `apps/os/backend/auth/auth.ts` OTP email:
   ```typescript
   from: `Iterate <${envParam.VITE_APP_STAGE}@alpha.iterate.com>`,
   ```

### 3. Inbound Email Stage Validation

Validate that inbound emails are addressed to the correct stage.

**Location:** `apps/os/backend/integrations/resend/resend.ts`

**Logic:**
```typescript
// In webhook handler, after parsing payload
const expectedPrefix = env.VITE_APP_STAGE; // e.g., "dev-mmkal", "prd"
const recipientEmail = emailData.to[0];
const recipientLocal = recipientEmail.split('@')[0];

// Validate stage matches (recipient should start with stage prefix)
if (!recipientLocal.startsWith(expectedPrefix)) {
  logger.warn("[Resend Webhook] Email sent to wrong stage", {
    expected: expectedPrefix,
    got: recipientLocal,
  });
  return c.json({ ok: true, message: "Email addressed to different stage" });
}
```

**Alternative:** Use `+` addressing for project routing: `{stage}+{projectslug}@alpha.iterate.com`

### 4. Future: Per-Env Domains (Optional)

For cleaner separation, could set up:
- `dev.iterate.com` - all dev envs
- `stg.iterate.com` - staging
- `iterate.com` or `alpha.iterate.com` - production

Would require:
- Separate Resend domains per env
- Separate API keys per domain
- DNS setup for each

**Recommendation:** Defer this until we need it. Stage prefix in address is simpler.

## Tasks

- [ ] Add egress proxy interception for `api.resend.com/emails`
- [ ] Implement org member email validation
- [ ] Update from address to include stage
- [ ] Add inbound email stage validation
- [ ] Test end-to-end: send email from sandbox, verify recipient restriction works
- [ ] Test inbound: send email to wrong stage, verify it's rejected

## Open Questions

1. Should we allow sending to CC/BCC as well, with same restrictions?
2. Should there be a way for admins to add external email addresses to allowlist?
3. Should the error message reveal the restriction policy, or be vague for security?
