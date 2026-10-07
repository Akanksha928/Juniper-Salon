// Imported by the Workflow sandbox, so keep this file free of Node APIs.

import { weekdayOf } from "./matching";
import type { Availability, Slot, TextingHours, WaitlistStatus, Weekday } from "./types";

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

// ---------- Salon time ----------
// Everything below works in an explicit IANA time zone (e.g.
// "America/Los_Angeles"), never the machine's, so the Workflow gets the same
// answer on every Worker and on replay.

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The salon's wall-clock date (YYYY-MM-DD), weekday and time (HH:MM) at an instant.
export function salonClock(ms: number, timeZone: string): { date: string; weekday: Weekday; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, weekday: weekdayOf(date), time: `${parts.hour}:${parts.minute}` };
}

// The instant when the salon's clock reads `time` on `date`.
export function salonTimeToMs(date: string, time: string, timeZone: string): number {
  const wall = Date.parse(`${date}T${time}:00Z`);
  // The zone's offset from UTC at an instant, from what its clock reads then.
  const offset = (ms: number) => {
    const clock = salonClock(ms, timeZone);
    return Date.parse(`${clock.date}T${clock.time}:00Z`) - (ms - (ms % 60000));
  };
  // Check the offset again at the result, in case a DST change falls between.
  const first = wall - offset(wall);
  return wall - offset(first);
}

// Midnight at the end of `date` in the salon's time zone, as an ISO instant.
export function endOfDay(date: string, timeZone: string): string {
  return new Date(salonTimeToMs(addDays(date, 1), "00:00", timeZone)).toISOString();
}

// Whether the salon is open at a slot's date and time (YYYY-MM-DD, HH:MM).
export function isWithinHours(date: string, time: string, hours: Availability): boolean {
  return hours.days.includes(weekdayOf(date)) && hours.from <= time && time < hours.to;
}

// Whether a client may be texted at this instant.
export function isTextingTime(ms: number, hours: TextingHours): boolean {
  const clock = salonClock(ms, hours.timeZone);
  return isWithinHours(clock.date, clock.time, hours);
}

// The earliest instant from `nowMs` when an offer can go out: within opening
// hours, with its whole reply window ending by closing time. If the window is
// longer than a whole opening day, it only has to start within hours.
export function nextTextingTime(nowMs: number, replyWindowMs: number, hours: TextingHours): number {
  const today = salonClock(nowMs, hours.timeZone).date;
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, offset);
    if (!hours.days.includes(weekdayOf(date))) continue;
    const open = salonTimeToMs(date, hours.from, hours.timeZone);
    const close = salonTimeToMs(date, hours.to, hours.timeZone);
    const start = Math.max(nowMs, open);
    const mustEndBy = replyWindowMs <= close - open ? close - replyWindowMs : close - 1;
    if (start <= mustEndBy) return start;
  }
  throw new Error("The salon's opening hours have no open days");
}

// "Tue 9:00 AM", in the salon's time zone.
export function describeSalonTime(ms: number, timeZone: string): string {
  const clock = salonClock(ms, timeZone);
  return `${clock.weekday} ${formatTime(clock.time)}`;
}

// "Tue–Sat, 9:00 AM–7:00 PM".
export function describeHours(hours: Availability): string {
  const days = hours.days;
  const order = DAYS.indexOf(days[0]);
  const consecutive = days.length > 2 && days.every((d, i) => DAYS.indexOf(d) === order + i);
  const dayText = consecutive ? `${days[0]}–${days.at(-1)}` : days.join(", ");
  return `${dayText}, ${formatTime(hours.from)}–${formatTime(hours.to)}`;
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
