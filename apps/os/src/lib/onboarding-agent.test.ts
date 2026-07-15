import { describe, expect, test } from "vitest";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";
import { isOnboardingActive } from "./onboarding-agent.ts";

const state = (overrides: Partial<ProjectProcessorState>): ProjectProcessorState => ({
  agents: [],
  birthCertificate: { config: { slug: "test" } },
  customDomains: [],
  egressRules: [],
  humanApprovalKeys: [],
  onboardingActive: false,
  onboardingCompletedAt: null,
  repos: [],
  ready: true,
  secrets: [],
  streams: [],
  ...overrides,
});

describe("isOnboardingActive", () => {
  test("keys off the phase marker alone — the agent may not have been explicitly created yet", () => {
    expect(isOnboardingActive(state({ onboardingActive: true }))).toBe(true);
    expect(isOnboardingActive(state({ onboardingActive: false }))).toBe(false);
  });
});
