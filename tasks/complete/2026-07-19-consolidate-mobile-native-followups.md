---
status: in-progress
size: small
branch: docs/mobile-native-followups
---

# Consolidate mobile native follow-up tasks

**Status summary:** complete. PR #2084's remaining work is consolidated in `tasks/mobile-native-followups.md`; the two completed mobile implementation tasks and their interview are archived under `tasks/complete/`; and the shared-itx-client task no longer asks for focus wiring that already landed.

## Why

PR #2084 established the signed native development client, scriptable device push, approval deep links, and the mobile drawer. Its final review left explicit follow-ups, while several older task files still describe Expo Go, push notifications, and React Native app-focus wiring as future work. The merged native-capabilities task also retains unchecked follow-ups and points to a location-reminders task that was never created.

## Checklist

- [x] Capture #2084's explicit review follow-ups: domain-model audit, approvals beyond HTTP with owning-stream navigation, and unread notification badges. _Consolidated in `tasks/mobile-native-followups.md` with the review as its source breadcrumb._
- [x] Preserve deferred native work from #2084: physical approval-push acceptance, early settlement/cancellation, Secure Enclave signing, and a redesigned location-reminder slice. _Each has an explicit checklist item in the consolidated follow-up._
- [x] Move the completed `os-ios-app` foundation and `mobile-native-capabilities` implementation tasks into `tasks/complete/` with dated filenames. _Archived under their merge dates._
- [x] Preserve the original iOS-app interview beside its completed implementation task as historical decision context. _Moved without rewriting its historical assumptions._
- [x] Update active consolidation tasks where #2084 already supplied React Native focus handling or changed the runtime assumptions. _The shared-itx-client task now marks focus wiring complete and retains the actual keeper/online work._
- [x] Verify every link between the consolidated task files resolves. _Repository task-link scan passes._

## Assumptions

- Completed task files remain useful historical evidence and should be moved, not rewritten to pretend their original Expo Go assumptions were never made.
- Approval protocol extraction remains an independent mechanical consolidation task; this pass should link it rather than merge it into broader product design.
- The follow-up task records product/design work only. It does not reopen the merged implementation in this documentation PR.
