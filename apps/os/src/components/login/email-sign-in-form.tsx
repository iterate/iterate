import { useId } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { SecretInput } from "@iterate-com/ui/components/not-recorded";
import { focusOnMount } from "../focus-on-mount.ts";

/** Email, then either a mailed code or the deployment's password. With both configured the code is
 *  the default and the password the alternate; switching posts the form back to the page in the
 *  other mode, keeping the email typed — and focus goes to the password once the email is known. */
export function EmailSignInForm({
  next,
  email,
  passwordEnabled,
  codeEnabled,
  passwordSelected,
}: {
  next: string;
  email: string;
  passwordEnabled: boolean;
  codeEnabled: boolean;
  passwordSelected: boolean;
}) {
  const emailId = useId();
  const passwordId = useId();
  const usePassword = passwordEnabled && (!codeEnabled || passwordSelected);
  const focusPassword = usePassword && Boolean(email);
  return (
    <form method="post" action="/login" className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <Field>
        <FieldLabel htmlFor={emailId}>Email</FieldLabel>
        <Input
          id={emailId}
          type="email"
          name="email"
          defaultValue={email}
          autoComplete="email"
          required
          ref={focusPassword ? undefined : focusOnMount}
          className="h-11 px-3 text-base md:text-base"
        />
      </Field>
      {usePassword ? (
        <Field>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
          <SecretInput
            id={passwordId}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            ref={focusPassword ? focusOnMount : undefined}
            className="h-11 px-3 text-base md:text-base"
          />
        </Field>
      ) : null}
      <Button type="submit" size="lg" className="h-11">
        {usePassword ? "Sign in" : "Send me a code"}
      </Button>
      {passwordEnabled && codeEnabled ? (
        <Button
          type="submit"
          variant="ghost"
          name="method"
          value={usePassword ? "code" : "password"}
          formNoValidate
          className="h-9 text-[0.8rem]"
        >
          {usePassword ? "Use email code instead" : "Use password instead"}
        </Button>
      ) : null}
    </form>
  );
}
