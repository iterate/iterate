import { useRef, useState, useTransition, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { useHydrated, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type { ConsentView } from "../../consent.ts";
import { projectSlug } from "../../control-plane/catalog.ts";
import { createProjectForConsent } from "../../issuer.functions.ts";
import { switchAccountHref } from "../../login-search.ts";
import { IssuerPage } from "../issuer-page.tsx";
import { ClientHeading } from "./client-heading.tsx";
import { OnboardingStep } from "./onboarding-step.tsx";
import { PermissionsStep } from "./permissions-step.tsx";
import type { ProjectSelection } from "./project-choices.tsx";
import type { ProjectDraft } from "./project-fields.tsx";
import { ProjectsStep } from "./projects-step.tsx";
import { SignedInAccount } from "./signed-in-account.tsx";
import { SomeoneElseStep } from "./someone-else-step.tsx";

/** The consent page for a request the platform accepted. Three steps: a first project for someone
 *  with none, then which projects the client may reach, then which of the permissions it asked for
 *  to grant — or, for a platform admin, "Sign in as someone else…" instead. Choices live here, so a
 *  refreshed description (after a project is created) and a trip between the steps never drop one.
 *  Authorize is a plain POST to this very authorization URL. */
export function ConsentCard({
  view,
  authorization,
  platformOrigin,
}: {
  view: Extract<ConsentView, { kind: "consent" }>;
  authorization: string;
  platformOrigin: string;
}) {
  const router = useRouter();
  const createProject = useServerFn(createProjectForConsent);
  const hydrated = useHydrated();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<"projects" | "permissions" | "someone-else">("projects");
  const [selection, setSelection] = useState<ProjectSelection>({
    all: !view.projectBound,
    excluded: new Set(),
  });
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<ProjectDraft>({
    open: false,
    slug: "",
    followsName: true,
    orgId: view.orgs[0]?.id ?? "",
    organizationName: view.orgs.length ? "" : view.suggestedOrganizationName,
  });
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Controls do nothing until React owns them; disabled, a test (or a quick hand) waits for that.
  const disabled = !hydrated || pending;
  const orgNames = new Map(view.orgs.map((org) => [org.id, org.name]));
  const projects = view.projects.map((project) => ({
    id: project.id,
    slug: project.slug,
    orgName: orgNames.get(project.orgId) ?? project.orgId,
  }));
  const selected = selection.all
    ? projects
    : projects.filter((project) => !selection.excluded.has(project.id));
  const onboarding = !view.projectBound && !view.projects.length;
  const organizationName = draft.orgId ? (orgNames.get(draft.orgId) ?? "") : draft.organizationName;
  const slug = onboarding && draft.followsName ? projectSlug(organizationName) : draft.slug;
  const switchAccount = switchAccountHref(`/oauth2/auth${authorization}`);

  /** Change step and move focus to its heading, so the change is announced. */
  function showStep(next: "projects" | "permissions" | "someone-else") {
    flushSync(() => {
      setStep(next);
      setError(null);
    });
    headingRef.current?.focus();
  }

  /** Create the drafted project (and its new organization, when one is named), then refresh the
   *  description. The first project goes straight on to the permissions. */
  function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // cleared first, so a refusal (even the same one again) is a new alert that takes focus
    const invalid = draftError(slug, draft);
    setError(invalid);
    if (invalid) return;
    const first = onboarding;
    startTransition(async () => {
      try {
        const result = await createProject({
          data: {
            authorization,
            slug,
            organization: draft.orgId ? { id: draft.orgId } : { name: draft.organizationName },
          },
        });
        // An ended session is redirected to sign-in: useServerFn has already navigated there and
        // resolves with nothing, so this page has nothing left to update.
        if (!result) return;
        await router.invalidate();
        // An organization made for a refused project stays chosen for the retry.
        const orgId = result.orgId || draft.orgId;
        if (result.error) {
          setDraft((current) => ({ ...current, orgId }));
          setError(result.error);
          return;
        }
        setDraft({ open: false, slug: "", followsName: true, orgId, organizationName: "" });
        if (first) showStep("permissions");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
  }

  const fields = {
    draft,
    slug,
    orgs: view.orgs,
    ingressRouting: view.ingressRouting,
    platformOrigin,
    disabled,
    onDraftChange: setDraft,
  };

  const frame = {
    account: (
      <SignedInAccount
        email={view.email}
        picture={view.picture}
        switchAccount={switchAccount}
        onSignInAsSomeoneElse={
          view.impersonation && step !== "someone-else" ? () => showStep("someone-else") : undefined
        }
      />
    ),
    error,
    // Creating a project takes the platform a few seconds; say so while the controls wait.
    status: pending ? "Creating project…" : null,
    denyLocation: view.denyLocation,
  };

  return (
    <IssuerPage wide className="gap-8 md:gap-10">
      <ClientHeading
        clientName={view.clientName}
        clientLogoUri={view.clientLogoUri}
        clientDomain={view.clientDomain}
      />
      {step === "someone-else" && view.impersonation ? (
        <SomeoneElseStep
          headingRef={headingRef}
          frame={frame}
          clientName={view.clientName}
          clientId={view.clientId}
          impersonation={view.impersonation}
          onBack={() => showStep("projects")}
        />
      ) : onboarding ? (
        <OnboardingStep
          headingRef={headingRef}
          frame={frame}
          fields={fields}
          onCreateProject={submitDraft}
        />
      ) : step === "projects" ? (
        <ProjectsStep
          headingRef={headingRef}
          frame={frame}
          projects={projects}
          projectBound={view.projectBound}
          selection={selection}
          fields={fields}
          canReview={selection.all || selected.length > 0}
          onSelectionChange={setSelection}
          onCreateProject={submitDraft}
          onReview={() => showStep("permissions")}
        />
      ) : (
        <PermissionsStep
          headingRef={headingRef}
          frame={frame}
          all={selection.all}
          selected={selected}
          scopes={view.scopes}
          declined={declined}
          disabled={disabled}
          onDeclinedChange={setDeclined}
          onEditProjects={() => showStep("projects")}
        />
      )}
    </IssuerPage>
  );
}

/** Why the drafted project cannot be created yet, or null when it can. */
function draftError(slug: string, draft: ProjectDraft) {
  if (!slug.trim()) return "Enter a project name.";
  if (!draft.orgId && !draft.organizationName.trim()) return "Enter an organization name.";
  return null;
}
