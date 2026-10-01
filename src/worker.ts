import { NativeConnection, Worker } from "@temporalio/worker";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: "assessment-starter",
    workflowsPath: require.resolve("./workflows"),
  });
  console.log("Worker is polling the assessment-starter task queue.");
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

