# Slack preview OAuth clients

Do not create preview Slack apps by copying slot-specific manifests and pasting
their secrets into chat. Use the generic, API-first runbook:

- [Slack apps for preview environments](../apps/os/docs/slack-preview-app-manifest.md)
- [Adding preview slots](adding-preview-slots.md)

Slack's `apps.manifest.create` response contains the client ID, client secret,
and signing secret. An agent can pipe those fields directly into the matching
Doppler config without displaying them. Browser automation is still useful for
the initial workspace authorization and the final OS Connect Slack flow.

This file previously held hundreds of lines of duplicated manifests for
individual slots. That was easy to drift, impossible to resume reliably, and
encouraged an unsafe credential handoff. The manifest now has one source in the
OS runbook and is parameterized by slot number.
