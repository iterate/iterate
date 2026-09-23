import { useId } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";

/** Email, then either a mailed code or the deployment's password. With both configured the code is
 *  the default and the password the alternate; switching posts the form back to the page in the
 *  other mode, keeping the email typed. */
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
  return (
    <form method="post" action="/login" className="flex flex-col gap-4">
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
        />
      </Field>
      {usePassword ? (
        <Field>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
          <Input
            id={passwordId}
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </Field>
      ) : null}
      <Button type="submit" size="lg">
        {usePassword ? "Sign in" : "Send me a code"}
      </Button>
      {passwordEnabled && codeEnabled ? (
        <Button
          type="submit"
          variant="ghost"
          name="method"
          value={usePassword ? "code" : "password"}
          formNoValidate
        >
          {usePassword ? "Use email code instead" : "Use password instead"}
        </Button>
      ) : null}
    </form>
  );
}
