import path from "node:path";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
} from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { cancelOpening, getWaitlistStatus, markHandled, replyToOffer } from "./messages";
import { matchClients } from "./matching";
import { localDate, rejectionNotice, TASK_QUEUE } from "./shared";
import type { Slot, StaffActionResult, WaitlistInput, WaitlistStatus } from "./types";
import { loadWaitlist } from "./waitlist";
import type { waitlistWorkflow } from "./workflows";

// Demo default is 30 seconds; the Workflow's own default is 15 minutes.
const RESPONSE_TIMEOUT_SECONDS = Number(process.env.RESPONSE_TIMEOUT_SECONDS ?? 30);
const OUTBOX_URL = `http://127.0.0.1:${process.env.OUTBOX_PORT ?? 3001}/outbox`;
// Keep requests short when no Worker is running, so the UI can say so.
const WORKER_DEADLINE_MS = 3000;

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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

app.get("/api/config", (_request, response) => {
  response.json({ responseTimeoutSeconds: RESPONSE_TIMEOUT_SECONDS });
});

function isSlot(value: Record<string, unknown>): boolean {
  return (
    isText(value.stylist) &&
    isText(value.service) &&
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    typeof value.time === "string" &&
    /^\d{2}:\d{2}$/.test(value.time)
  );
}

// Preview for the cancellation form. Uses the same matching as the
// findMatchingClients Activity, so the preview and the Workflow agree.
app.get("/api/matches", async (request, response) => {
  if (!isSlot(request.query)) {
    response.status(400).json({ error: "Please provide a stylist, service, date, and time." });
    return;
  }
  const { stylist, service, date, time } = request.query as Record<string, string>;
  try {
    response.json(
      matchClients({ stylist, service, date, time }, await loadWaitlist()).map((c) => ({
        name: c.name,
        preferredStylist: c.preferredStylist,
        joinedAt: c.joinedAt,
      })),
    );
  } catch (error) {
    response.status(500).json({ error: (error as Error).message });
  }
});

// The whole waitlist, earliest to join first, for the page's Waitlist section.
app.get("/api/waitlist", async (_request, response) => {
  try {
    const entries = await loadWaitlist();
    response.json(
      entries
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.name.localeCompare(b.name))
        .map(({ name, phone, service, availabilityText, preferredStylist, joinedAt }) => ({
          name,
          phone,
          service,
          availability: availabilityText,
          preferredStylist,
          joinedAt,
        })),
    );
  } catch (error) {
    response.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/slots", async (request, response) => {
  const body = request.body ?? {};
  if (!isSlot(body)) {
    response.status(400).json({ error: "Please provide a stylist, service, date, and time." });
    return;
  }
  const { stylist, service, date, time } = body as Record<string, string>;

  // The Workflow ID is derived from the slot, so Temporal itself refuses to
  // run a second waitlist for the same opening.
  const slotId = `${date}-${slug(stylist)}-${time.replace(":", "")}`;
  const workflowId = `slot-${slotId}`;
  const input: WaitlistInput = {
    slot: { slotId, stylist: stylist.trim(), service: service.trim(), date, time },
    responseTimeoutMs: RESPONSE_TIMEOUT_SECONDS * 1000,
  };

  const client = await getClient();
  try {
    await client.workflow.start<typeof waitlistWorkflow>("waitlistWorkflow", {
      workflowId,
      taskQueue: TASK_QUEUE,
      args: [input],
      // Lets the openings list show the slot even when no Worker can answer queries.
      memo: { slot: input.slot },
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      response.status(409).json({
        error: "A waitlist has already run for this slot. Pick a different time or stylist.",
        workflowId,
      });
      return;
    }
    throw error;
  }
  response.status(201).json({ workflowId });
});

// Every open waitlist, from Temporal, so every browser sees the same list. A
// waitlist Workflow keeps running until its slot is booked, cancelled, or
// marked handled by the front desk.
app.get("/api/slots", async (_request, response) => {
  const client = await getClient();
  const running: { workflowId: string; slot?: Slot }[] = [];
  try {
    const query = `WorkflowType = 'waitlistWorkflow' AND ExecutionStatus = 'Running'`;
    for await (const workflow of client.workflow.list({ query })) {
      running.push({ workflowId: workflow.workflowId, slot: workflow.memo?.slot as Slot | undefined });
    }
  } catch {
    response.status(503).json({ error: "Could not reach Temporal." });
    return;
  }
  const openings = await Promise.all(
    running.map(async ({ workflowId, slot }) => {
      try {
        const status = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
          client.workflow.getHandle(workflowId).query(getWaitlistStatus),
        );
        return { workflowId, slot: status.slot, status };
      } catch {
        // No Worker to answer: still list it, without live status.
        return { workflowId, slot, status: null as WaitlistStatus | null };
      }
    }),
  );
  // Hide slots in the moment between being booked/cancelled/handled and ending.
  const done = (s: WaitlistStatus | null) => s?.phase === "booked" || s?.phase === "cancelled" || s?.handled;
  response.json(openings.filter((o) => o.slot && !done(o.status)));
});

app.get("/api/slots/:workflowId", async (request, response) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.workflowId);
  try {
    const status = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
      handle.query(getWaitlistStatus),
    );
    response.json(status);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      response.status(404).json({ error: "No waitlist found for this slot." });
      return;
    }
    // Queries need a Worker; the Workflow itself is still safe in Temporal.
    response.status(503).json({ error: "Worker unavailable", workerOffline: true });
  }
});

// Rejected replies never reach the Workflow, so the API texts the client
// itself through the Worker's simulated SMS gateway. Best effort: the reply
// stays rejected even if the text can't be sent.
async function textRejectedClient(workflowId: string, clientId: string): Promise<void> {
  try {
    const client = await getClient();
    const status = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
      client.workflow.getHandle(workflowId).query(getWaitlistStatus),
    );
    const notice = rejectionNotice(status, clientId, localDate(new Date()));
    if (!notice) return;
    await fetch(OUTBOX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, ...notice }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}

app.post("/api/slots/:workflowId/reply", async (request, response) => {
  const { clientId, accept } = request.body ?? {};
  if (!isText(clientId) || typeof accept !== "boolean") {
    response.status(400).json({ error: "Please provide clientId and accept." });
    return;
  }
  const client = await getClient();
  const handle = client.workflow.getHandle(request.params.workflowId);
  try {
    const result = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
      handle.executeUpdate(replyToOffer, { args: [{ clientId, accept }] }),
    );
    response.json(result);
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      await textRejectedClient(request.params.workflowId, clientId);
      response.status(409).json({ error: error.cause?.message ?? "Reply rejected." });
      return;
    }
    if (error instanceof WorkflowNotFoundError || /completed/i.test(String(error))) {
      await textRejectedClient(request.params.workflowId, clientId);
      response.status(409).json({ error: "Sorry, this offer has closed." });
      return;
    }
    response.status(503).json({ error: "The salon system is busy. Please try again.", workerOffline: true });
  }
});

// Front-desk actions are messages to the running Workflow (never a
// terminate), so it can finish cleanly: text whoever holds the offer, or close
// out a slot that was waiting on the front desk.
async function staffAction(
  request: Request,
  response: Response,
  update: typeof cancelOpening | typeof markHandled,
): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(String(request.params.workflowId));
  try {
    const result: StaffActionResult = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
      handle.executeUpdate(update),
    );
    response.json(result);
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      response.status(409).json({ error: error.cause?.message ?? "That action isn't possible right now." });
      return;
    }
    if (error instanceof WorkflowNotFoundError || /completed/i.test(String(error))) {
      response.status(409).json({ error: "This opening has already closed." });
      return;
    }
    response.status(503).json({ error: "The salon system is busy. Please try again.", workerOffline: true });
  }
}

app.post("/api/slots/:workflowId/cancel", (request, response) => staffAction(request, response, cancelOpening));
app.post("/api/slots/:workflowId/handled", (request, response) => staffAction(request, response, markHandled));

app.get("/api/outbox", async (request, response) => {
  const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId : "";
  try {
    const outbox = await fetch(`${OUTBOX_URL}?workflowId=${encodeURIComponent(workflowId)}`, {
      signal: AbortSignal.timeout(1000),
    });
    response.json({ available: true, messages: await outbox.json() });
  } catch {
    response.json({ available: false, messages: [] });
  }
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
app.listen(port, () =>
  console.log(
    `Juniper Salon waitlist is available at http://localhost:${port} ` +
      `(reply window: ${RESPONSE_TIMEOUT_SECONDS}s)`,
  ),
);
