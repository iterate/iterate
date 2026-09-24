import { useId } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { SecretInput } from "@iterate-com/ui/components/not-recorded";
import { focusOnMount } from "../focus-on-mount.ts";

/** The mailed code, and the way back to another email. */
export function CodeSignInForm({ next, codeSentTo }: { next: string; codeSentTo: string }) {
  const codeId = useId();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        We sent a code to <strong className="wrap-anywhere">{codeSentTo}</strong>.
      </p>
      <form method="post" action="/login" className="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <Field>
          <FieldLabel htmlFor={codeId}>Code</FieldLabel>
          {/* it signs in until it is used: not in a replay */}
          <SecretInput
            id={codeId}
            type="text"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            ref={focusOnMount}
            className="h-11 text-center text-2xl tracking-[0.45em] tabular-nums md:text-2xl"
          />
        </Field>
        <Button type="submit" size="lg" className="h-11">
          Continue
        </Button>
      </form>
      <form method="post" action="/login" className="flex flex-col">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="restart" value="1" />
        <Button type="submit" variant="ghost" className="h-9 text-[0.8rem]">
          Use a different email
        </Button>
      </form>
    </div>
  );
}
