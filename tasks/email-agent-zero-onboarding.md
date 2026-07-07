---
status: grilling
size: large
branch: email-agent-zero-onboarding
---

# E2E global email agent with zero onboarding

## Raw ask (verbatim from Misha)

> e2e global email agent with zero onboarding
>
> how it'll work:
>
> Joe Bloggs wants something done. He just emails bot@iterate.com and we receive it via some global webhook/cloudflare email handler worker thing. (e.g. "Make me a browser slime volleyball game" from joebloggs@gmail.com to bot@iterate.com)
> we map joebloggs@gmail.com to a user/organization/project. If none exist, we create them in the auth service
> we consider this request *trusted* - i will rely on you to determine what exactly that means in terms of scopes etc. but the important thing is: we *know* this email came from joebloggs@gmail.com so we *don't* need to separately auth in order to just do what's asked
>
> not important to set up MX records for bot@iterate.com to work spelled exactly like that yet - the flow is what I want, but I do want to be able to test that it works. Use best judgement for how to do that with preview-${n} slots

## Status

Task file being fleshed out via grill session. Spec and checklist to follow.
