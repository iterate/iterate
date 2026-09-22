# OAuth rollout proof

- `notes-save-reload.webm` and `notes.png`: real Notes UI on localhost, production issuer and project APIs. Fresh account, consent/onboarding, save, then reload and read the persisted file. No mocked RPC or page reload to repair sign-in.
- `spa-consent.png`: deployed SPA preview at iterate-spa-preview.iterate-dev-preview.workers.dev, real dynamic registration and consent against the production issuer.
- `extension.png`: extension v0.2.1 loaded in an isolated Chrome for Testing profile. The production ZIP uses the same four runtime files and retains the existing manifest key/extension ID.

The Notes spec reproduced the old production `create` RPC failure before the fix. It now runs during Notes preview and production deployments. The SPA deploy verifies served oauth.js, SVG and ZIP bytes against its build after deployment.

Unpacked extensions require a reload in their installed Chrome profile. No personal Chrome profile was accessed for this proof.
