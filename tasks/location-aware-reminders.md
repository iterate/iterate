---
status: needs-design
size: large
---

# Location-aware reminders

**Status summary:** deferred. The first implementation was removed from PR #2084 because it committed to an agent event contract, first-phone ownership, MapKit candidate search, and iOS geofencing before the product semantics and background guarantees were convincing. Redesign this independently from the native-build and device-push foundation.

- [ ] Define the user-visible reminder lifecycle through real agent conversations: create, confirm, inspect, edit, complete, cancel, repeat, and re-entry behavior.
- [ ] Decide who owns a reminder when a project has multiple members and devices; do not silently assign every project reminder to the first phone that sees it.
- [ ] Decide whether “near a supermarket” means one confirmed place, a refreshed set of nearby candidates, a category search that moves with the user, or another explicit promise.
- [ ] Prototype iOS background behavior across lock, offline, reboot, and force-quit states before selecting the durable contract.
- [ ] Specify location privacy, retention, permission degradation, region-budget allocation, travel refresh, and observable failure states.
- [ ] Reintroduce native dependencies and server events only after the prototype demonstrates the intended behavior on a physical iPhone.

## Prior attempt

The removed implementation is preserved in branch history through commits beginning at `4ff99799c`. It used `expo-location`, `expo-task-manager`, a local `MKLocalSearch` Expo module, `/mobile/location-reminders` events, and device claim/release reconciliation. Treat it as a prototype to critique, not an API to restore wholesale.
