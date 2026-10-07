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
import { cancelOpening, dismissFilledNotice, getWaitlistStatus, markHandled, replyToOffer } from "./messages";
import { matchClients } from "./matching";
import { endOfDay, localDate, rejectionNotice, TASK_QUEUE } from "./shared";
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

// Shown to front desk staff, so no technical terms. The server log has the
// details.
const TEMPORAL_UNAVAILABLE = "The waitlist system isn't responding right now.";
const WORKER_UNAVAILABLE = "The waitlist is paused for a moment. Please try again shortly.";

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  })
    .then((connection) => new Client({ connection, namespace: "default" }))
    .catch((error: unknown) => {
      // Forget the failed attempt, so the next request tries again once
      // Temporal is up instead of failing until the API restarts.
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

// The Temporal Client, or undefined after answering 503 if Temporal can't be
// reached.
async function clientOrUnavailable(response: Response): Promise<Client | undefined> {
  try {
    return await getClient();
  } catch (error) {
    console.error(error);
    response.status(503).json({ error: TEMPORAL_UNAVAILABLE });
    return undefined;
  }
}

// A query or Update that times out means either no Worker answered or
// Temporal itself is down. A quick call to Temporal tells which, so the page
// can say the right thing.
async function respondUnavailable(client: Client, response: Response, error: unknown): Promise<void> {
  const temporalUp = await client
    .withDeadline(Date.now() + 1000, () => client.workflowService.getSystemInfo({}))
    .then(
      () => true,
      () => false,
    );
  if (temporalUp) {
    // The Workflow itself is still safe in Temporal; it just needs a Worker.
    response.status(503).json({ error: WORKER_UNAVAILABLE, workerOffline: true });
    return;
  }
  console.error(error);
  response.status(503).json({ error: TEMPORAL_UNAVAILABLE });
}

// Updates on a Workflow that has finished fail as "not found", just like an
// ID that never existed. Describing the Workflow tells the two apart.
async function workflowExists(client: Client, workflowId: string): Promise<boolean> {
  try {
    await client.workflow.getHandle(workflowId).describe();
    return true;
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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
    closesAt: endOfDay(date),
  };

  const client = await clientOrUnavailable(response);
  if (!client) return;
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
    console.error(error);
    response.status(503).json({ error: TEMPORAL_UNAVAILABLE });
    return;
  }
  response.status(201).json({ workflowId });
});

// Every running waitlist Workflow, from Temporal, so every browser sees the
// same thing: "openings" still need filling (or the front desk), "filled" are
// booked slots whose notice nobody has dismissed yet.
app.get("/api/slots", async (_request, response) => {
  const client = await clientOrUnavailable(response);
  if (!client) return;
  const running: { workflowId: string; slot?: Slot }[] = [];
  try {
    const query = `WorkflowType = 'waitlistWorkflow' AND ExecutionStatus = 'Running'`;
    for await (const workflow of client.workflow.list({ query })) {
      running.push({ workflowId: workflow.workflowId, slot: workflow.memo?.slot as Slot | undefined });
    }
  } catch {
    response.status(503).json({ error: TEMPORAL_UNAVAILABLE });
    return;
  }
  const slots = await Promise.all(
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
  const listed = slots.filter((s) => s.slot);
  // Cancelled and handled slots are hidden in the moment before they end.
  const open = (s: WaitlistStatus | null) => s?.phase !== "booked" && s?.phase !== "cancelled" && !s?.handled;
  response.json({
    openings: listed.filter((s) => open(s.status)),
    filled: listed.filter((s) => s.status?.phase === "booked" && !s.status.filledNoticeDismissed),
  });
});

app.get("/api/slots/:workflowId", async (request, response) => {
  const client = await clientOrUnavailable(response);
  if (!client) return;
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
    await respondUnavailable(client, response, error);
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
  const client = await clientOrUnavailable(response);
  if (!client) return;
  const { workflowId } = request.params;
  const handle = client.workflow.getHandle(workflowId);
  try {
    const result = await client.withDeadline(Date.now() + WORKER_DEADLINE_MS, () =>
      handle.executeUpdate(replyToOffer, { args: [{ clientId, accept }] }),
    );
    response.json(result);
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      await textRejectedClient(workflowId, clientId);
      response.status(409).json({ error: error.cause?.message ?? "Reply rejected." });
      return;
    }
    if (error instanceof WorkflowNotFoundError) {
      if (!(await workflowExists(client, workflowId))) {
        response.status(404).json({ error: "No waitlist found for this slot." });
        return;
      }
      await textRejectedClient(workflowId, clientId);
      response.status(409).json({ error: "Sorry, this offer has closed." });
      return;
    }
    await respondUnavailable(client, response, error);
  }
});

// Front-desk actions are messages to the running Workflow (never a
// terminate), so it can finish cleanly: text whoever holds the offer, or close
// out a slot that was waiting on the front desk.
async function staffAction(
  request: Request,
  response: Response,
  update: typeof cancelOpening | typeof markHandled | typeof dismissFilledNotice,
): Promise<void> {
  const client = await clientOrUnavailable(response);
  if (!client) return;
  const workflowId = String(request.params.workflowId);
  const handle = client.workflow.getHandle(workflowId);
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
    if (error instanceof WorkflowNotFoundError) {
      if (!(await workflowExists(client, workflowId))) {
        response.status(404).json({ error: "No waitlist found for this slot." });
        return;
      }
      response.status(409).json({ error: "This opening has already closed." });
      return;
    }
    await respondUnavailable(client, response, error);
  }
}

app.post("/api/slots/:workflowId/cancel", (request, response) => staffAction(request, response, cancelOpening));
app.post("/api/slots/:workflowId/handled", (request, response) => staffAction(request, response, markHandled));
app.post("/api/slots/:workflowId/dismiss", (request, response) =>
  staffAction(request, response, dismissFilledNotice),
);

app.get("/api/outbox", async (request, response) => {
  const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId : "";
  try {
    const outbox = await fetch(`${OUTBOX_URL}?workflowId=${encodeURIComponent(workflowId)}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!outbox.ok) throw new Error(`Outbox answered ${outbox.status}`);
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
