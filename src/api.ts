import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client, Connection } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import type { DemoStatus } from "./types";
import { demoWorkflow } from "./workflows";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

app.post("/api/demo", async (_request, response) => {
  const requestId = randomUUID();
  const client = await getClient();
  await client.workflow.start(demoWorkflow, {
    workflowId: requestId,
    taskQueue: "assessment-starter",
    args: [requestId],
  });
  response.status(201).json({ requestId });
});

app.get("/api/demo/:requestId", async (request, response) => {
  const client = await getClient();
  const status = await client.workflow
    .getHandle(request.params.requestId)
    .query<DemoStatus>("getDemoStatus");
  response.json(status);
});

app.post("/api/demo/:requestId/continue", async (request, response) => {
  const client = await getClient();
  await client.workflow
    .getHandle(request.params.requestId)
    .signal("continueDemo");
  response.status(202).json({ accepted: true });
});

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error(error);
    response.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  },
);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Starter is available at http://localhost:${port}`));

