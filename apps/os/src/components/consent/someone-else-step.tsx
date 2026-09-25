import { useId, useState, type Ref } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import type { ConsentView } from "../../consent.ts";
import { ConsentPanel, StepHeading, type ConsentFrame } from "./consent-step.tsx";

/** A PLATFORM ADMIN'S "Sign in as someone else…" (the consent view's `impersonation`, admins only):
 *  whom, typed with the platform's people as suggestions, and who the client really is — its
 *  verified host, where the code goes, the resource and the permissions it would hold as them, and
 *  a warning for anything that is not one of this deployment's own apps. Submit is a plain POST to
 *  this very authorization URL carrying `impersonate=<user id>` in the body, which the platform
 *  checks again (consent.ts `approve`). */
export function SomeoneElseStep({
  headingRef,
  frame,
  clientName,
  clientId,
  impersonation,
  onBack,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  frame: ConsentFrame;
  clientName: string;
  clientId: string;
  impersonation: NonNullable<Extract<ConsentView, { kind: "consent" }>["impersonation"]>;
  onBack: () => void;
}) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // the form posts the person's id, never the address typed: only someone on the list can be picked
  const chosen = impersonation.people.find((person) => person.email === email.trim().toLowerCase());
  const who = chosen?.email || "them";
  return (
    <ConsentPanel
      {...frame}
      summary={
        <section
          aria-label="The client"
          className="flex flex-col gap-2 rounded-xl border p-4 text-sm"
        >
          <h3 className="font-medium">{clientName}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Client</dt>
            <dd className="wrap-anywhere">
              {impersonation.metadataHost || `unverified client · ${clientId}`}
            </dd>
            <dt className="text-muted-foreground">Returns to</dt>
            <dd className="wrap-anywhere">{impersonation.redirectHost}</dd>
            <dt className="text-muted-foreground">Resource</dt>
            <dd>{impersonation.resource}</dd>
            <dt className="text-muted-foreground">Permissions</dt>
            <dd>
              <ul>
                {impersonation.scopes.map((scope) => (
                  <li key={scope.name}>{scope.title}</li>
                ))}
              </ul>
            </dd>
          </dl>
          {impersonation.ownApp ? null : (
            <p className="font-medium text-destructive">
              Not an iterate app — it will act as {who} for an hour.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Everything it does names you beside them, and both your accounts record it.
          </p>
        </section>
      }
      action={
        <Button
          type="submit"
          form={formId}
          size="lg"
          className="h-auto min-h-11 whitespace-normal"
          disabled={!chosen || submitting}
        >
          Sign {clientName} in as {who} for an hour
        </Button>
      }
    >
      <div className="flex items-center justify-between gap-4">
        <StepHeading ref={headingRef}>Sign in as someone else</StepHeading>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
      </div>
      <form
        id={formId}
        method="post"
        onSubmit={() => setSubmitting(true)}
        className="flex flex-col gap-2"
      >
        <Label htmlFor={`${formId}-email`}>Their email</Label>
        <Input
          id={`${formId}-email`}
          type="email"
          list={`${formId}-people`}
          autoComplete="off"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <datalist id={`${formId}-people`}>
          {impersonation.people.map((person) => (
            <option key={person.id} value={person.email} />
          ))}
        </datalist>
        {chosen ? <input type="hidden" name="impersonate" value={chosen.id} /> : null}
      </form>
    </ConsentPanel>
  );
}
