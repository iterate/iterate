import { useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";

type User = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role?: string | null;
};

type Organization = {
  id: string;
  name: string;
  slug: string;
};

type Project = {
  id: string;
  name: string;
  slug: string;
};

type PostHogIdentityOptions = {
  user: User | null;
  organization?: Organization | null;
  project?: Project | null;
};

/**
 * Hook to manage PostHog user identification and group analytics.
 *
 * Call this hook at different layout levels:
 * - Root/auth layout: with just the user
 * - Organization layout: with user + organization
 * - Project layout: with user + organization + project
 */
export function usePostHogIdentity({ user, organization, project }: PostHogIdentityOptions) {
  const posthog = usePostHog();
  const identifiedUserRef = useRef<string | null>(null);
  const identifiedOrgRef = useRef<string | null>(null);
  const identifiedProjectRef = useRef<string | null>(null);

  // Identify user
  useEffect(() => {
    if (!posthog) return;

    if (user && identifiedUserRef.current !== user.id) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
        avatar: user.image,
        role: user.role,
      });
      identifiedUserRef.current = user.id;
    } else if (!user && identifiedUserRef.current) {
      posthog.reset();
      identifiedUserRef.current = null;
      identifiedOrgRef.current = null;
      identifiedProjectRef.current = null;
    }
  }, [posthog, user]);

  // Set organization group
  useEffect(() => {
    if (!posthog || !user) return;

    if (organization && identifiedOrgRef.current !== organization.id) {
      posthog.group("organization", organization.id, {
        name: organization.name,
        slug: organization.slug,
      });
      identifiedOrgRef.current = organization.id;
    } else if (!organization && identifiedOrgRef.current) {
      // When leaving an org context, we don't reset the group - PostHog handles this
      identifiedOrgRef.current = null;
    }
  }, [posthog, user, organization]);

  // Set project group
  useEffect(() => {
    if (!posthog || !user || !organization) return;

    if (project && identifiedProjectRef.current !== project.id) {
      posthog.group("project", project.id, {
        name: project.name,
        slug: project.slug,
        organization_id: organization.id,
        organization_name: organization.name,
      });
      identifiedProjectRef.current = project.id;
    } else if (!project && identifiedProjectRef.current) {
      identifiedProjectRef.current = null;
    }
  }, [posthog, user, organization, project]);
}
