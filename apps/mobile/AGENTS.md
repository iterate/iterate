# Mobile app agent notes

Follow the repository-level instructions plus the mobile-specific guidance in
[`README.md`](./README.md).

## Clickable local demos in pull requests

When a mobile UI pull request has a useful Expo Web demo, run the app in LAN
mode and add a **Try locally** section to the pull request body. The section
must contain a clickable `http://<lan-ip>:<port>/<route>` link to the exact
screen being reviewed, not `localhost`, so the author can open it from a phone
on the same network. Include the matching `exp://<lan-ip>:<port>/--/<route>`
deep link as plain text when the screen is also useful in Expo Go.

For example:

```bash
pnpm --dir apps/mobile start:web --lan --port 8091
```

```md
## Try locally

[Open the mobile IDE demo](http://192.168.0.10:8091/project/demo-project/ide-prototype?demo=1)

Expo Go: `exp://192.168.0.10:8091/--/project/demo-project/ide-prototype?demo=1`
```

Resolve the current LAN address from the dev server output or the host network;
never guess it. State that the link requires the phone to be on the same LAN
and only remains live while that local Expo server is running. If the user asks
for a live link, keep that foreground server session running when handing the
PR back and report the link in the final response too.
