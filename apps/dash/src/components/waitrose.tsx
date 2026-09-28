// components/waitrose.tsx — CONNECTING WAITROSE, for a project (its Integrations page) or the person
// (/sessions): a username and a password, no consent. They go to the new connection's secret alone,
// `/secrets/waitrose-<connection>` with the `waitrose-session` strategy, which the platform logs in
// with on first use and whenever Waitrose answers 401; then the owner's facet records the connection
// (apps/os/src/integrations/waitrose-connection.ts `connectWaitrose`).
// oxlint-disable react/only-export-components -- the connect and its form are one flow: one file.
import { useState, type FormEvent, type RefObject } from "react";
import { ShoppingBasket } from "lucide-react";
import type { AuthenticatedApp } from "iterate/app";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { freshConnectionName } from "../lib/connections.ts";

/** Where Waitrose logs in (apps/os/src/integrations/waitrose.ts): the secret's pin and its login. */
const WAITROSE_GRAPHQL_URL = "https://www.waitrose.com/api/graphql";

type WaitroseCredentials = { username: string; password: string };

/** Connect a Waitrose account on `owner` — a project's context, or the person's (`api.user`) —
 *  whose `facet` records its connections. A connect the facet refuses deletes the secret it set. */
export async function connectWaitrose(
  owner: AuthenticatedApp["api"]["user"],
  facet: "project" | "account",
  { username, password }: WaitroseCredentials,
) {
  const connection = freshConnectionName();
  const secretPath = `/secrets/waitrose-${connection}`;
  await owner.secrets.set(
    secretPath,
    { username, password },
    {
      urls: [new URL(WAITROSE_GRAPHQL_URL).origin],
      refresh: { kind: "waitrose-session", graphqlUrl: WAITROSE_GRAPHQL_URL },
    },
  );
  await owner.facets
    .get(facet)
    .invoke([["connectWaitrose", { connection, account: username }]])
    .catch(async (caught: unknown) => {
      await owner.secrets.delete(secretPath).catch(() => {});
      throw caught;
    });
}

/** The Waitrose sheet's form: the username and password, and the connect's own error. */
export function WaitroseForm({
  firstField,
  onBack,
  onPendingChange,
  onConnect,
}: {
  /** The email field, for the sheet's initial focus. */
  firstField: RefObject<HTMLInputElement | null>;
  /** Back to the sheet it came from, when there is one. */
  onBack?: () => void;
  /** Whether a connect is in flight, for the sheet around it (it stays open until the answer). */
  onPendingChange: (pending: boolean) => void;
  onConnect: (credentials: WaitroseCredentials) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    onPendingChange(true);
    try {
      await onConnect({ username, password });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPending(false);
    } finally {
      onPendingChange(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex h-full flex-col">
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <ShoppingBasket aria-hidden="true" className="size-5 text-muted-foreground" />
          Connect Waitrose
        </SheetTitle>
        <SheetDescription>The password is only ever sent to waitrose.com.</SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 px-4 pb-4">
        <Field>
          <FieldLabel htmlFor="waitrose-username">Email</FieldLabel>
          <Input
            id="waitrose-username"
            ref={firstField}
            type="email"
            autoComplete="off"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value.trim())}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="waitrose-password">Password</FieldLabel>
          <Input
            id="waitrose-password"
            type="password"
            autoComplete="off"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" data-type="error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        {onBack && (
          <Button type="button" variant="ghost" disabled={pending} onClick={onBack}>
            Back
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Connect
        </Button>
      </SheetFooter>
    </form>
  );
}
