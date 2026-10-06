import type { Slot, WaitlistEntry, Weekday } from "./types";

const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayOf(date: string): Weekday {
  // Parse as UTC so the weekday doesn't depend on the server's time zone.
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function isAvailable(entry: WaitlistEntry, date: string, time: string): boolean {
  const day = weekdayOf(date);
  return entry.availability.some((w) => w.days.includes(day) && w.from <= time && time < w.to);
}

// Who on the waitlist can take this slot, earliest to join first. Shared by
// the findMatchingClients Activity and the form's match preview.
export function matchClients(
  slot: Pick<Slot, "stylist" | "service" | "date" | "time">,
  entries: WaitlistEntry[],
): WaitlistEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.service === slot.service &&
        isAvailable(entry, slot.date, slot.time) &&
        (!entry.preferredStylist || entry.preferredStylist === slot.stylist),
    )
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.name.localeCompare(b.name));
}
