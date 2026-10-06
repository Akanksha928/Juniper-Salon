import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { readOutbox, recordMessage } from "./outbox";
import { TASK_QUEUE } from "./shared";

// The outbox lives in this process, so expose it to the API over HTTP.
// POST lets the API text clients whose replies the Workflow rejected.
function serveOutbox(port: number): void {
  createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/outbox") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "POST") {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        try {
          const { workflowId, to, toName, body } = JSON.parse(raw);
          if (![workflowId, to, toName, body].every((v) => typeof v === "string" && v)) throw new Error();
          const sent = recordMessage({ id: randomUUID(), workflowId, kind: "rejection", to, toName, body });
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(JSON.stringify(sent));
        } catch {
          response.writeHead(400).end();
        }
      });
      return;
    }
    const workflowId = url.searchParams.get("workflowId") ?? undefined;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(readOutbox(workflowId)));
  }).listen(port, "127.0.0.1");
}

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities,
  });
  serveOutbox(Number(process.env.OUTBOX_PORT ?? 3001));
  console.log(`Worker is polling the ${TASK_QUEUE} task queue.`);
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
