---
status: needs-grilling
size: medium
---

# Mobile bug-reporting infra

High-level ask (verbatim from Misha):

> let's add some bug-reporting infra to the mobile app. what i want:
> for preview builds, show a bug emoji thing in the sidebar. it should just be a link to github which goes to the pull request for that build (i don't think we propagate this right now but it should be easy to do like the sha/preview branch etc.)
> that way i can screenshot and leave a screenshot. but i think we can go further too
>
> * we can store events for every interaction on the mobile app - screen navigations, errors etc.
> * for now i don't think they actually need to *drive* the mobile app because that'd get a bit complicated i think esp since we don't want to actually be remote-controlling the app from the cloud
> * but it can just be a factual log of what the user (currently, just me) did on the app
> * if there's a way to github deeplink to a PR with a comment template pre-filled then maybe we could do that. or basically whatever makes it possible to provide the agent working on a PR with maximal context about the session so the report is as helpful for the agent as possible

Being grilled — spec to follow.
