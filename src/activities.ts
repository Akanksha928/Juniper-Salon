import { Context } from "@temporalio/activity";
import { matchClients } from "./matching";
import { recordMessage } from "./outbox";
import { describeSlot, formatDuration, formatSlotDay, formatTime, localDate } from "./shared";
import type { Slot, WaitlistClient } from "./types";
import { loadWaitlist } from "./waitlist";

function workflowId(): string {
  return Context.current().info.workflowExecution?.workflowId ?? "standalone";
}

// Texts say "today" or "on Mon, Oct 19", judged when the text is sent.
function today(): string {
  return localDate(new Date());
}

function slotDay(slot: Slot): string {
  return formatSlotDay(slot.date, today());
}

// Clients who want this service, are free at this time, and either have no
// stylist preference or prefer this stylist, earliest to join first.
// Reads data/waitlist.csv fresh each time; in production this would read the
// salon's Google Sheet. If the file can't be read, the Activity retries a few
// times (fixing the file quickly lets the slot carry on); after that the
// Workflow hands the slot to the front desk and shows the error.
export async function findMatchingClients(slot: Slot): Promise<WaitlistClient[]> {
  return matchClients(slot, await loadWaitlist()).map(({ clientId, name, phone }) => ({ clientId, name, phone }));
}

export async function sendOffer(input: {
  slot: Slot;
  client: WaitlistClient;
  responseTimeoutMs: number;
}): Promise<void> {
  const { slot, client, responseTimeoutMs } = input;
  recordMessage({
    id: `${workflowId()}:offer:${client.clientId}`,
    workflowId: workflowId(),
    kind: "offer",
    to: client.phone,
    toName: client.name,
    body:
      `Hi ${client.name}, a ${slot.service} with ${slot.stylist} just opened ${slotDay(slot)} at ` +
      `${formatTime(slot.time)}. Reply YES to book or NO to pass. ` +
      `We'll hold it for you for ${formatDuration(responseTimeoutMs)}.`,
  });
}

export async function bookAppointment(input: {
  slot: Slot;
  client: WaitlistClient;
}): Promise<string> {
  const bookingId = `${input.slot.slotId}-${input.client.clientId}`;
  console.log(`[booking] ${bookingId}: ${input.client.name} booked with ${input.slot.stylist}`);
  return bookingId;
}

export async function sendConfirmation(input: {
  slot: Slot;
  client: WaitlistClient;
}): Promise<void> {
  const { slot, client } = input;
  recordMessage({
    id: `${workflowId()}:confirmation:${client.clientId}`,
    workflowId: workflowId(),
    kind: "confirmation",
    to: client.phone,
    toName: client.name,
    body:
      `You're booked! ${slot.service} with ${slot.stylist} ${slotDay(slot)} at ${formatTime(slot.time)}. ` +
      `See you soon at Juniper Salon.`,
  });
}

export async function sendCancellationNotice(input: {
  slot: Slot;
  client: WaitlistClient;
}): Promise<void> {
  const { slot, client } = input;
  recordMessage({
    id: `${workflowId()}:cancellation:${client.clientId}`,
    workflowId: workflowId(),
    kind: "cancellation",
    to: client.phone,
    toName: client.name,
    body:
      `Sorry, the ${describeSlot(slot, today())} is no longer available. ` +
      `You're still on the waitlist for future openings.`,
  });
}

export async function notifyFrontDeskFilled(input: { slot: Slot; client: WaitlistClient }): Promise<void> {
  const { slot, client } = input;
  recordMessage({
    id: `${workflowId()}:staff_filled`,
    workflowId: workflowId(),
    kind: "staff_filled",
    to: "front-desk",
    toName: "Front desk",
    body: `Filled: ${client.name} booked the ${describeSlot(slot, today())} (simulated — Square not updated).`,
  });
}

// `problem` is set when the slot needs the front desk because a step failed,
// e.g. the waitlist couldn't be read, rather than because nobody took it.
export async function notifyStaff(input: { slot: Slot; clientsOffered: number; problem?: string }): Promise<void> {
  const { slot, clientsOffered, problem } = input;
  const described = describeSlot(slot, today());
  recordMessage({
    id: `${workflowId()}:staff_alert`,
    workflowId: workflowId(),
    kind: "staff_alert",
    to: "front-desk",
    toName: "Front desk",
    body: problem
      ? `${problem}. Please fill the ${described} manually.`
      : clientsOffered === 0
        ? `Nobody on the waitlist matches the ${described}. Please fill it manually.`
        : `Nobody on the waitlist took the ${described} ` +
          `(${clientsOffered} client${clientsOffered === 1 ? "" : "s"} offered). Please fill it manually.`,
  });
}
