import {
  condition,
  defineQuery,
  defineSignal,
  setHandler,
} from "@temporalio/workflow";
import type { DemoStatus } from "./types";

// This neutral Workflow exists only to prove that the starter is connected.
// Replace it with the customer Workflow you design during the assessment.
export const continueDemo = defineSignal("continueDemo");
export const getDemoStatus = defineQuery<DemoStatus>("getDemoStatus");

export async function demoWorkflow(requestId: string): Promise<DemoStatus> {
  let shouldContinue = false;
  let status: DemoStatus = {
    requestId,
    phase: "started",
    message: "The demo Workflow started.",
  };

  setHandler(getDemoStatus, () => status);
  setHandler(continueDemo, () => {
    shouldContinue = true;
  });

  status = {
    ...status,
    phase: "waiting",
    message: "The Workflow is durably waiting for a Signal.",
  };

  await condition(() => shouldContinue);

  status = {
    ...status,
    phase: "complete",
    message: "The Signal arrived and the Workflow completed.",
  };
  return status;
}

