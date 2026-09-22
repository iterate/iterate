# OAuth client branding

Desktop and phone screenshots of the local issuer with a real dynamically registered
Example App client and a local demonstration account. The HTTPS logo response is a
browser-controlled SVG fixture; registration, sign-in and consent use the real Worker.

The browser specs in `apps/os-next/specs/issuer-pages.spec.ts` cover this same flow,
including an undecodable logo, referrer omission and preserving branding between steps.

`first-party-consent.png` and `sessions-{desktop,phone}.png` show the deployed
PR #2825 previews after real CIMD sign-ins to Dash, Agents, Notes and Voice.
The account and project are disposable preview fixtures; every logo is the
app's own deployed SVG, with no intercepted requests or fabricated session rows.
