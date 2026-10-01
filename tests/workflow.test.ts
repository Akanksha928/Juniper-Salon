import assert from "node:assert/strict";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { demoWorkflow } from "../src/workflows";

test("the starter Workflow waits for a Signal and completes", async () => {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: "starter-test",
      workflowsPath: require.resolve("../src/workflows"),
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(demoWorkflow, {
        workflowId: "starter-test",
        taskQueue: "starter-test",
        args: ["starter-test"],
      });
      await handle.signal("continueDemo");
      const result = await handle.result();
      assert.equal(result.phase, "complete");
    });
  } finally {
    await environment.teardown();
  }
});

