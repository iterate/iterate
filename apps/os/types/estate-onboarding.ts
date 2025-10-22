export type EstateOnboardingStepStatus = "pending" | "in_progress" | "completed" | "error";

export type EstateOnboardingState = "pending" | "in_progress" | "completed" | "error";

export interface EstateOnboardingStep {
  name: string;
  status: EstateOnboardingStepStatus;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface EstateOnboardingData {
  steps: EstateOnboardingStep[];
}
