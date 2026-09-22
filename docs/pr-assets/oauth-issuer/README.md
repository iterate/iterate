# Issuer UI walkthrough

`walkthrough.mp4` records password sign-in and the two-step OAuth consent against the local
OS-Next Worker. The clips showing all sign-in methods and email-code entry are presentation
fixtures, labeled in the video; they do not exercise Google's login or send email.

The video uses the annotated Middlewright output from `VIDEO_MODE=1` runs of the first
Claude consent test, the password/error test, the all-methods login case, and the code-entry
case in `apps/os-next/specs`. Captions were added with FFmpeg. The screenshots show the
password field before/after and the two consent steps, using local demonstration identities.
