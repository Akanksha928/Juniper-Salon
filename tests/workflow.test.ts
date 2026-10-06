import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import * as activities from "../src/activities";
import { cancelOpening, getWaitlistStatus, markHandled, replyToOffer } from "../src/messages";
import { readOutbox } from "../src/outbox";
import { rejectionNotice } from "../src/shared";
import type { Slot, WaitlistClient, WaitlistInput, WaitlistStatus } from "../src/types";
import { waitlistWorkflow } from "../src/workflows";

const TASK_QUEUE = "waitlist-test";
const TIMEOUT_MS = 15 * 60 * 1000;

const waitlist: WaitlistClient[] = [
  { clientId: "c1", name: "Priya", phone: "+15550100001" },
  { clientId: "c2", name: "Daniel", phone: "+15550100002" },
  { clientId: "c3", name: "Rosa", phone: "+15550100003" },
];

let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
let counter = 0;

// Each test picks who matches its slot, so these tests exercise the offer
// loop independently of the sample waitlist (see matching.test.ts).
const matchesBySlot = new Map<string, WaitlistClient[]>();

before(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      ...activities,
      findMatchingClients: async (slot: Slot) => matchesBySlot.get(slot.slotId) ?? [],
    },
  });
  workerRun = worker.run();
});

after(async () => {
  worker.shutdown();
  await workerRun;
  await environment.teardown();
});

// Monday, Jan 7 2030: never "today", so text wording is stable.
const SLOT_DATE = "2030-01-07";

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function startWaitlist(
  clients = waitlist,
  date = SLOT_DATE,
): Promise<WorkflowHandle<typeof waitlistWorkflow>> {
  const id = `slot-test-${++counter}`;
  matchesBySlot.set(id, clients);
  const input: WaitlistInput = {
    slot: { slotId: id, stylist: "Maya", service: "Cut & style", date, time: "14:00" },
    responseTimeoutMs: TIMEOUT_MS,
  };
  return environment.client.workflow.start(waitlistWorkflow, {
    workflowId: id,
    taskQueue: TASK_QUEUE,
    args: [input],
  });
}

async function waitForOfferTo(
  handle: WorkflowHandle<typeof waitlistWorkflow>,
  clientId: string,
): Promise<WaitlistStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await handle.query(getWaitlistStatus);
    if (status.currentClientId === clientId) return status;
    await delay(50);
  }
  throw new Error(`Offer never reached ${clientId}`);
}

// Skips through reply windows until the slot is waiting on the front desk.
// (The Workflow then waits for "Mark handled", so result() alone would hang.)
async function waitForFrontDesk(handle: WorkflowHandle<typeof waitlistWorkflow>): Promise<WaitlistStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await handle.query(getWaitlistStatus);
    if (status.staffNotified) return status;
    if (status.currentClientId) await environment.sleep(TIMEOUT_MS + 1000);
    else await delay(50);
  }
  throw new Error("Slot never reached the front desk");
}

test("the first client accepts and is booked", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });

  const result = await handle.result();
  assert.equal(result.phase, "booked");
  assert.equal(result.bookedClientId, "c1");
  assert.deepEqual(result.offers.map((o) => o.state), ["accepted"]);
  const texts = readOutbox(handle.workflowId).map((m) => `${m.kind}:${m.to}`);
  assert.deepEqual(texts, ["offer:+15550100001", "confirmation:+15550100001"]);
});

test("offer and confirmation texts give the slot's date unless it's today", async () => {
  const later = await startWaitlist([waitlist[0]]);
  await waitForOfferTo(later, "c1");
  await later.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });
  await later.result();
  assert.deepEqual(readOutbox(later.workflowId).map((m) => m.body), [
    "Hi Priya, a Cut & style with Maya just opened on Mon, Jan 7 at 2:00 PM. " +
      "Reply YES to book or NO to pass. We'll hold it for you for 15 minutes.",
    "You're booked! Cut & style with Maya on Mon, Jan 7 at 2:00 PM. See you soon at Juniper Salon.",
  ]);

  const today = await startWaitlist([waitlist[0]], localToday());
  await waitForOfferTo(today, "c1");
  await today.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });
  await today.result();
  const [offer, confirmation] = readOutbox(today.workflowId).map((m) => m.body);
  assert.match(offer, /just opened today at 2:00 PM\./);
  assert.match(confirmation, /with Maya today at 2:00 PM\./);
});

test("a decline moves the offer to the next client", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: false }] });
  await waitForOfferTo(handle, "c2");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c2", accept: true }] });

  const result = await handle.result();
  assert.equal(result.bookedClientId, "c2");
  assert.deepEqual(result.offers.map((o) => o.state), ["declined", "accepted"]);
});

test("no reply within the timeout moves the offer to the next client", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await environment.sleep(TIMEOUT_MS + 1000);
  await waitForOfferTo(handle, "c2");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c2", accept: true }] });

  const result = await handle.result();
  assert.deepEqual(result.offers.map((o) => o.state), ["timed_out", "accepted"]);
});

test("staff are notified when nobody takes the slot", async () => {
  const handle = await startWaitlist();
  const status = await waitForFrontDesk(handle);

  assert.equal(status.phase, "unfilled");
  assert.deepEqual(status.offers.map((o) => o.state), ["timed_out", "timed_out", "timed_out"]);
  const staffAlerts = readOutbox(handle.workflowId).filter((m) => m.kind === "staff_alert");
  assert.deepEqual(staffAlerts.map((m) => m.body), [
    "Nobody on the waitlist took the 2:00 PM Cut & style with Maya on Mon, Jan 7 (3 clients offered). " +
      "Please fill it manually.",
  ]);
  await handle.executeUpdate(markHandled);
  await handle.result();
});

test("a slot with the front desk stays open until it's marked handled", async () => {
  const handle = await startWaitlist();
  await waitForFrontDesk(handle);

  // Still running, waiting on the front desk, and late replies stay rejected.
  await environment.sleep(24 * 60 * 60 * 1000);
  const waiting = await handle.query(getWaitlistStatus);
  assert.equal(waiting.handled, false);
  assert.equal((await handle.describe()).status.name, "RUNNING");
  await assert.rejects(handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] }));

  await handle.executeUpdate(markHandled);
  const result = await handle.result();
  assert.equal(result.phase, "unfilled");
  assert.equal(result.handled, true);
  assert.equal(result.events.at(-1)?.kind, "handled");
});

test("Mark handled is rejected unless the slot is waiting on the front desk", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await assert.rejects(handle.executeUpdate(markHandled)); // still offering

  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });
  assert.equal((await handle.result()).phase, "booked");
  await assert.rejects(handle.executeUpdate(markHandled)); // booked and finished
});

test("with no matching clients, the front desk is alerted right away", async () => {
  const handle = await startWaitlist([]);
  const status = await waitForFrontDesk(handle);

  assert.equal(status.phase, "unfilled");
  assert.deepEqual(status.waitlist, []);
  assert.deepEqual(status.offers, []);
  // No timers ran: the alert went out without waiting on any reply window.
  const elapsed = Date.parse(status.events.at(-1)!.at) - Date.parse(status.events[0].at);
  assert.ok(elapsed < TIMEOUT_MS, `alert took ${elapsed}ms`);
  const texts = readOutbox(handle.workflowId);
  assert.deepEqual(texts.map((m) => m.kind), ["staff_alert"]);
  assert.equal(
    texts[0].body,
    "Nobody on the waitlist matches the 2:00 PM Cut & style with Maya on Mon, Jan 7. Please fill it manually.",
  );
  await handle.executeUpdate(markHandled);
  await handle.result();
});

test("the Workflow offers the slot to matches in the order they're found", async () => {
  const handle = await startWaitlist([waitlist[2], waitlist[0]]);
  await waitForOfferTo(handle, "c3");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c3", accept: false }] });
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });

  const result = await handle.result();
  assert.deepEqual(result.waitlist.map((c) => c.clientId), ["c3", "c1"]);
  assert.deepEqual(result.offers.map((o) => o.clientId), ["c3", "c1"]);
});

test("late and out-of-turn replies are rejected", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");

  // Daniel replies before it's his turn.
  await assert.rejects(
    handle.executeUpdate(replyToOffer, { args: [{ clientId: "c2", accept: true }] }),
  );

  // Priya's window closes; her late YES must not book the slot.
  await environment.sleep(TIMEOUT_MS + 1000);
  await waitForOfferTo(handle, "c2");
  await assert.rejects(
    handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] }),
  );

  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c2", accept: true }] });
  const result = await handle.result();
  assert.equal(result.bookedClientId, "c2");
  assert.equal(result.events.filter((e) => e.kind === "booked").length, 1);
});

test("clients whose replies are rejected are owed a sorry text, others aren't", async () => {
  const handle = await startWaitlist();
  const offering = await waitForOfferTo(handle, "c1");

  // Out of turn: Daniel is owed a text; Priya holds the offer.
  const today = localToday();
  const outOfTurn = rejectionNotice(offering, "c2", today);
  assert.equal(outOfTurn?.to, "+15550100002");
  assert.equal(
    outOfTurn?.body,
    "Sorry, the 2:00 PM Cut & style with Maya on Mon, Jan 7 has been offered to someone else. " +
      "You're still on the waitlist for future openings.",
  );
  // Same text for a slot that's today says "today" instead of the date.
  assert.match(rejectionNotice(offering, "c2", SLOT_DATE)!.body, /^Sorry, the 2:00 PM Cut & style with Maya today has/);
  assert.equal(rejectionNotice(offering, "c1", today), undefined);

  // Late (Priya timed out) and after booking (Rosa never got an offer).
  await environment.sleep(TIMEOUT_MS + 1000);
  await waitForOfferTo(handle, "c2");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c2", accept: true }] });
  const booked = await handle.result();
  assert.ok(rejectionNotice(booked, "c1", today));
  assert.ok(rejectionNotice(booked, "c3", today));
  assert.equal(rejectionNotice(booked, "c2", today), undefined); // Daniel replied and won

  // An unfilled slot went to the front desk, not "someone else".
  const unfilledHandle = await startWaitlist();
  const unfilled = await waitForFrontDesk(unfilledHandle);
  assert.equal(rejectionNotice(unfilled, "c1", today), undefined);
  await unfilledHandle.executeUpdate(markHandled);
});

test("cancelling mid-offer ends the waitlist and tells the client holding the offer", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(cancelOpening);

  const result = await handle.result(); // ends without waiting out the reply window
  assert.equal(result.phase, "cancelled");
  assert.equal(result.currentClientId, undefined);
  assert.deepEqual(result.offers.map((o) => o.state), ["withdrawn"]);
  assert.equal(result.events.at(-1)?.kind, "cancelled");
  const elapsed = Date.parse(result.events.at(-1)!.at) - Date.parse(result.events[0].at);
  assert.ok(elapsed < TIMEOUT_MS, `cancel took ${elapsed}ms`);

  // Priya got her offer and then the cancellation; Daniel and Rosa got nothing.
  const texts = readOutbox(handle.workflowId);
  assert.deepEqual(texts.map((m) => `${m.kind}:${m.to}`), ["offer:+15550100001", "cancellation:+15550100001"]);
  assert.equal(
    texts[1].body,
    "Sorry, the 2:00 PM Cut & style with Maya on Mon, Jan 7 is no longer available. " +
      "You're still on the waitlist for future openings.",
  );
});

test("replies after cancelling are rejected and owed no sorry text", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(cancelOpening);

  for (const clientId of ["c1", "c2"]) {
    await assert.rejects(handle.executeUpdate(replyToOffer, { args: [{ clientId, accept: true }] }));
  }
  const result = await handle.result();
  assert.equal(result.phase, "cancelled");
  assert.equal(result.bookedClientId, undefined);
  // The holder already got the cancellation text; "offered to someone else" would be untrue.
  assert.equal(rejectionNotice(result, "c1", localToday()), undefined);
  assert.equal(rejectionNotice(result, "c2", localToday()), undefined);
});

test("a cancel is rejected once a client has taken the slot, or if already cancelled", async () => {
  const booked = await startWaitlist();
  await waitForOfferTo(booked, "c1");
  await booked.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: true }] });
  await assert.rejects(booked.executeUpdate(cancelOpening));
  assert.equal((await booked.result()).phase, "booked");

  const cancelled = await startWaitlist();
  await waitForOfferTo(cancelled, "c1");
  await cancelled.executeUpdate(cancelOpening);
  await assert.rejects(cancelled.executeUpdate(cancelOpening));
  assert.equal(readOutbox(cancelled.workflowId).filter((m) => m.kind === "cancellation").length, 1);
});

test("a decline right before a cancel stays a decline; only the offer holder is told", async () => {
  const handle = await startWaitlist();
  await waitForOfferTo(handle, "c1");
  await handle.executeUpdate(replyToOffer, { args: [{ clientId: "c1", accept: false }] });
  await handle.executeUpdate(cancelOpening);

  // The cancel may land before or after Daniel is offered the slot; either
  // way Priya's NO stands, and only someone whose offer was withdrawn is told.
  const result = await handle.result();
  assert.equal(result.phase, "cancelled");
  assert.equal(result.offers[0].state, "declined");
  const withdrawn = result.offers.filter((o) => o.state === "withdrawn").map((o) => o.clientId);
  assert.ok(withdrawn.every((id) => id === "c2"));
  const told = readOutbox(handle.workflowId).filter((m) => m.kind === "cancellation").map((m) => m.toName);
  assert.deepEqual(told, withdrawn.map(() => "Daniel"));
});
