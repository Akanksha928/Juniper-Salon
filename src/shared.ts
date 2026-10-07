// Imported by the Workflow sandbox, so keep this file free of Node APIs.

import type { Slot, WaitlistStatus } from "./types";

export const TASK_QUEUE = "juniper-waitlist";

// Real-world default. The demo API passes a shorter timeout (see api.ts).
export const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

export function formatTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "today" for a slot on `today`, otherwise "on Mon, Oct 19". Both dates are
// YYYY-MM-DD in the salon's time zone.
export function formatSlotDay(date: string, today: string): string {
  if (date === today) return "today";
  const day = new Date(`${date}T00:00:00Z`);
  return `on ${DAYS[day.getUTCDay()]}, ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
}

// YYYY-MM-DD in this process's local time zone, which is the salon's.
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Midnight at the end of `date` (YYYY-MM-DD) in this process's local time
// zone, as an ISO instant. Depends on the time zone, so never call it inside
// the Workflow: the API works it out and passes it in.
export function endOfDay(date: string): string {
  const end = new Date(`${date}T00:00`);
  end.setDate(end.getDate() + 1);
  return end.toISOString();
}

// "5:00 PM Cut & style with Maya today" or "... with Maya on Mon, Oct 19".
export function describeSlot(slot: Slot, today: string): string {
  return `${formatTime(slot.time)} ${slot.service} with ${slot.stylist} ${formatSlotDay(slot.date, today)}`;
}

// The text owed to a client whose reply was rejected because the offer had
// moved on: late, out of turn, or after booking. Undefined when no text is
// owed: the client already replied, holds the current offer, or the slot
// went to the front desk or was cancelled.
export function rejectionNotice(
  status: WaitlistStatus,
  clientId: string,
  today: string,
): { to: string; toName: string; body: string } | undefined {
  const client = status.waitlist.find((c) => c.clientId === clientId);
  const offer = status.offers.find((o) => o.clientId === clientId);
  if (!client || status.currentClientId === clientId) return undefined;
  if (status.phase === "unfilled" || status.phase === "cancelled") return undefined;
  if (offer?.state === "accepted" || offer?.state === "declined") return undefined;
  return {
    to: client.phone,
    toName: client.name,
    body:
      `Sorry, the ${describeSlot(status.slot, today)} has been offered to someone else. ` +
      `You're still on the waitlist for future openings.`,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
