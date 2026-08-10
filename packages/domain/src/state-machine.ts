import type { WorkStatus } from "./schemas.js";

const allowedTransitions: Record<WorkStatus, readonly WorkStatus[]> = {
  proposed: ["approved", "canceled"],
  approved: ["running", "canceled"],
  running: ["awaiting_acceptance", "failed", "canceled"],
  awaiting_acceptance: ["completed", "approved", "canceled"],
  completed: [],
  failed: ["approved", "canceled"],
  canceled: [],
};

export function canTransitionWork(from: WorkStatus, to: WorkStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertWorkTransition(from: WorkStatus, to: WorkStatus): void {
  if (!canTransitionWork(from, to)) throw new Error(`illegal Work transition: ${from} -> ${to}`);
}
