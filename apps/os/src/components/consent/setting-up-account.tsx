import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "../ui/button.tsx";
import { IterateLogo } from "../iterate-logo.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { StandalonePage } from "../standalone-page.tsx";

/** How long the page keeps asking: past the longest Cloudflare has held a new Durable Object before
 *  starting it (45 s, previews 2026-09-24 to 09-28). */
const ASK_AGAIN_FOR_MS = 60_000;
/** The pause between one answer and the next ask. */
const ASK_AGAIN_AFTER_MS = 1_000;

/** The person's account is not answering yet (consent-page.server.ts `describeConsent`): at a first
 *  sign-in its Durable Object may still be starting. The page asks again, the route's `beforeLoad`
 *  once more, a second after each answer, and shows the consent once the account answers. After a
 *  minute it stops and says so; Try again asks for another minute. */
export function SettingUpAccount() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const started = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const askAgain = () => {
      if (Date.now() - started >= ASK_AGAIN_FOR_MS) {
        setGaveUp(true);
        return;
      }
      void router.invalidate().finally(() => {
        if (!stopped) timer = setTimeout(askAgain, ASK_AGAIN_AFTER_MS);
      });
    };
    timer = setTimeout(askAgain, ASK_AGAIN_AFTER_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [router, round]);
  return (
    <StandalonePage className="items-center gap-4 text-center text-sm">
      <IterateLogo alt="" className="size-14" />
      {gaveUp ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Your account is not ready yet</h1>
          <p role="alert" data-type="error">
            Setting up your account is taking longer than it should. Nothing was granted.
          </p>
          <Button
            type="button"
            size="lg"
            className="h-11 w-full"
            onClick={() => {
              setGaveUp(false);
              setRound(round + 1);
            }}
          >
            Try again
          </Button>
        </>
      ) : (
        <>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Spinner className="size-5" />
            Setting up your account…
          </h1>
          <p className="text-muted-foreground">
            This takes a few seconds the first time you sign in.
          </p>
        </>
      )}
    </StandalonePage>
  );
}
