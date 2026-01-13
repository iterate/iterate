import { useContext, useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { PostHogIdentityContext, type IdentityState } from "./posthog-identity-context.ts";

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
 * Uses shared context to prevent duplicate calls across nested layouts.
 *
 * Call this hook at different layout levels:
 * - Root/auth layout: with just the user
 * - Organization layout: with user + organization
 * - Project layout: with user + organization + project
 */
export function usePostHogIdentity({ user, organization, project }: PostHogIdentityOptions) {
  const posthog = usePostHog();
  const sharedState = useContext(PostHogIdentityContext);

  const fallbackRef = useRef<IdentityState>({
    userId: null,
    organizationId: null,
    projectId: null,
  });

  const state = sharedState?.current ?? fallbackRef.current;

  // Single consolidated effect for user identification and group analytics
  useEffect(() => {
    if (!posthog) return;

    // Handle user identification
    if (user && state.userId !== user.id) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
        avatar: user.image,
        role: user.role,
      });
      state.userId = user.id;
      // Reset org/project state when user changes to prevent stale data
      state.organizationId = null;
      state.projectId = null;
    } else if (!user && state.userId) {
      posthog.reset();
      state.userId = null;
      state.organizationId = null;
      state.projectId = null;
      return;
    }

    if (!user) return;

    // Handle organization group
    // Only set if org is provided and different from current state
    // Only clear if org is explicitly null (not undefined - undefined means "not managing this")
    if (organization && state.organizationId !== organization.id) {
      posthog.group("organization", organization.id, {
        name: organization.name,
        slug: organization.slug,
      });
      state.organizationId = organization.id;
    } else if (organization === null && state.organizationId) {
      state.organizationId = null;
    }

    // Handle project group
    // Only set if project is provided and different from current state
    // Only clear if project is explicitly null (not undefined - undefined means "not managing this")
    if (organization && project && state.projectId !== project.id) {
      posthog.group("project", project.id, {
        name: project.name,
        slug: project.slug,
        organization_id: organization.id,
        organization_name: organization.name,
      });
      state.projectId = project.id;
    } else if (project === null && state.projectId) {
      state.projectId = null;
    }
  }, [posthog, user, organization, project, state]);
}
