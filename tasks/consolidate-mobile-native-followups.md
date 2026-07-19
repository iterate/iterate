---
status: in-progress
size: small
branch: docs/mobile-native-followups
---

# Consolidate mobile native follow-up tasks

**Status summary:** specification complete; the task inventory still needs to be reconciled with merged PR #2084. The intended result is one current follow-up task, completed historical task files moved out of the active backlog, and surviving backlog tasks corrected where #2084 already completed part of their scope.

## Why

PR #2084 established the signed native development client, scriptable device push, approval deep links, and the mobile drawer. Its final review left explicit follow-ups, while several older task files still describe Expo Go, push notifications, and React Native app-focus wiring as future work. The merged native-capabilities task also retains unchecked follow-ups and points to a location-reminders task that was never created.

## Checklist

- [ ] Capture #2084's explicit review follow-ups: domain-model audit, approvals beyond HTTP with owning-stream navigation, and unread notification badges.
- [ ] Preserve deferred native work from #2084: physical approval-push acceptance, early settlement/cancellation, Secure Enclave signing, and a redesigned location-reminder slice.
- [ ] Move the completed `os-ios-app` foundation and `mobile-native-capabilities` implementation tasks into `tasks/complete/` with dated filenames.
- [ ] Preserve the original iOS-app interview beside its completed implementation task as historical decision context.
- [ ] Update active consolidation tasks where #2084 already supplied React Native focus handling or changed the runtime assumptions.
- [ ] Verify every link between the consolidated task files resolves.

## Assumptions

- Completed task files remain useful historical evidence and should be moved, not rewritten to pretend their original Expo Go assumptions were never made.
- Approval protocol extraction remains an independent mechanical consolidation task; this pass should link it rather than merge it into broader product design.
- The follow-up task records product/design work only. It does not reopen the merged implementation in this documentation PR.
