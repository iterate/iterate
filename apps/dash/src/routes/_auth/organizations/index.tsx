// /organizations — every organization the session reaches, in the projects page's layout: a table
// (the name → its settings, the id, the person's role, how many projects), and "New organization"
// (`?new=1`, a sheet: a name) when the grant holds `organizations:write`, a step-up link otherwise.
import { useState, type FormEvent } from "react";
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@iterate-com/ui/components/field";
import { Identifier } from "@iterate-com/ui/components/identifier";
import { Input } from "@iterate-com/ui/components/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@iterate-com/ui/components/sheet";
import { Spinner } from "@iterate-com/ui/components/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iterate-com/ui/components/table";
import { AllowOrganizations } from "../../../components/allow-organizations.tsx";
import { ListPage } from "../../../components/list-page.tsx";

const shell = getRouteApi("/_auth");

export const Route = createFileRoute("/_auth/organizations/")({
  validateSearch: z.object({ new: z.literal(1).optional().catch(undefined) }),
  staticData: { page: "Organizations" },
  component: OrganizationsPage,
});

function OrganizationsPage() {
  const { orgs } = shell.useLoaderData();
  const { info } = shell.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  return (
    <>
      <ListPage
        title="Organizations"
        action={
          <Button onClick={() => navigate({ to: "/organizations", search: { new: 1 } })}>
            <Plus data-icon="inline-start" />
            New organization
          </Button>
        }
        empty={
          orgs.length ? undefined : "No organizations yet — “New organization” creates the first."
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Id</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Projects</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.map((org) => (
              <TableRow key={org.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/organizations/$orgId"
                    params={{ orgId: org.id }}
                    className="underline-offset-4 hover:underline"
                  >
                    {org.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Identifier value={org.id} textClassName="text-xs" />
                </TableCell>
                <TableCell className="text-muted-foreground">{org.role || "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{org.projects}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListPage>
      {/* the projects page's sheet, for an organization: dismiss refused while the create is in
          flight so Escape and the backdrop cannot race it */}
      <Sheet
        open={search.new === 1}
        onOpenChange={(open) => {
          if (open || pending) return;
          void navigate({ to: "/organizations", search: {}, replace: true });
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={!pending}
          className="overflow-y-auto data-[side=right]:sm:max-w-md"
        >
          <NewOrganizationForm
            canWrite={info.scopes.includes("organizations:write")}
            pending={pending}
            setPending={setPending}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The sheet's body — mounted with the sheet, so every opening starts blank. A created
 *  organization opens on its settings. */
function NewOrganizationForm({
  canWrite,
  pending,
  setPending,
}: {
  canWrite: boolean;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const { api } = shell.useRouteContext();
  const router = useRouter();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await api.createOrg(name.trim());
      await router.invalidate();
      await navigate({ to: "/organizations/$orgId", params: { orgId: created.id } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={create} className="flex h-full flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>New organization</SheetTitle>
        <SheetDescription>
          An organization holds projects and the people who work in them. Its name is free text.
        </SheetDescription>
      </SheetHeader>
      <FieldGroup className="flex-1 p-4">
        <Field>
          <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
          <Input
            id="organization-name"
            placeholder="Acme"
            autoComplete="organization"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        {canWrite ? null : <AllowOrganizations next="/organizations?new=1" />}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </FieldGroup>
      <SheetFooter className="border-t sm:flex-row sm:justify-end">
        <SheetClose disabled={pending} render={<Button type="button" variant="outline" />}>
          Cancel
        </SheetClose>
        <Button type="submit" disabled={pending || !canWrite || !name.trim()}>
          {pending ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Create organization
        </Button>
      </SheetFooter>
    </form>
  );
}
