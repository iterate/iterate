import { z } from "zod";
import { signIn } from "./auth.ts";

const SignInMessage = z.object({ type: z.literal("iterate:sign-in") });

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!SignInMessage.safeParse(message).success) return;

  void signIn().then(
    () => sendResponse({ ok: true }),
    (cause: unknown) =>
      sendResponse({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  );
  return true;
});
