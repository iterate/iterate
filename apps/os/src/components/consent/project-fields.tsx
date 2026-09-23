import { useId } from "react";
import { Field, FieldDescription, FieldLabel } from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@iterate-com/ui/components/native-select";
import type { IngressRouting } from "iterate/next/project-ingress";
import type { Org } from "../../directory.ts";
import { typedSlug } from "./project-slug.ts";

/** A project about to be created on the consent page: its slug as typed (or, on the first
 *  project, following the organization's name until edited) and its organization — one of the
 *  person's (`orgId`), or a new one named here (`orgId` empty). */
export interface ProjectDraft {
  open: boolean;
  slug: string;
  followsName: boolean;
  orgId: string;
  organizationName: string;
}

/** Module-level so its identity is stable: React calls it once, as the field appears. */
function focusOnMount(node: HTMLInputElement | null) {
  node?.focus();
}

/** The organization (a select of the person's, or a new one's name) and the project's slug, with
 *  where this deployment will serve it. */
export function ProjectFields({
  draft,
  slug,
  orgs,
  ingressRouting,
  platformOrigin,
  disabled,
  focusSlug,
  onDraftChange,
}: {
  draft: ProjectDraft;
  slug: string;
  orgs: Org[];
  ingressRouting: IngressRouting;
  platformOrigin: string;
  disabled: boolean;
  /** move focus to the slug as the fields appear — the New project form, just opened */
  focusSlug?: boolean;
  onDraftChange: (draft: ProjectDraft) => void;
}) {
  const organizationId = useId();
  const organizationNameId = useId();
  const slugId = useId();
  const shownSlug = slug || "my-project";
  const hostedAt = !ingressRouting
    ? null
    : ingressRouting.type === "subdomains"
      ? `${shownSlug}.${ingressRouting.hostname}`
      : `${platformOrigin}/projects/${shownSlug}/`;
  return (
    <div className="flex flex-col gap-4">
      {orgs.length ? (
        <Field>
          <FieldLabel htmlFor={organizationId}>Organization</FieldLabel>
          <NativeSelect
            id={organizationId}
            className="w-full"
            value={draft.orgId}
            disabled={disabled}
            onChange={(event) => onDraftChange({ ...draft, orgId: event.target.value })}
          >
            {orgs.map((org) => (
              <NativeSelectOption key={org.id} value={org.id}>
                {org.name}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="">New organization…</NativeSelectOption>
          </NativeSelect>
        </Field>
      ) : null}
      {draft.orgId ? null : (
        <Field>
          <FieldLabel htmlFor={organizationNameId}>Organization name</FieldLabel>
          <Input
            id={organizationNameId}
            value={draft.organizationName}
            placeholder="Acme"
            autoComplete="organization"
            required
            disabled={disabled}
            onChange={(event) => onDraftChange({ ...draft, organizationName: event.target.value })}
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor={slugId}>Project slug</FieldLabel>
        <Input
          id={slugId}
          value={slug}
          placeholder="my-project"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
          ref={focusSlug ? focusOnMount : undefined}
          disabled={disabled}
          onChange={(event) =>
            onDraftChange({ ...draft, slug: typedSlug(event.target.value), followsName: false })
          }
        />
        {hostedAt ? (
          <FieldDescription>Your project will be hosted at {hostedAt}</FieldDescription>
        ) : null}
      </Field>
    </div>
  );
}
