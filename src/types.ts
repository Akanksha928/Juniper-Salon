export type Slot = {
  slotId: string;
  stylist: string;
  service: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM, 24-hour
};

export type WaitlistClient = {
  clientId: string;
  name: string;
  phone: string;
};

export type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";

// A weekly window: on these days, from `from` (inclusive) to `to` (exclusive).
export type Availability = {
  days: Weekday[];
  from: string; // HH:MM, 24-hour
  to: string; // HH:MM, 24-hour
};

// The salon's opening hours, e.g. Tue–Sat 09:00–19:00, in its IANA time zone
// (e.g. "America/Los_Angeles"). Slots must fall within them, and client texts
// only go out within them.
export type TextingHours = Availability & {
  timeZone: string;
};

// One row of the salon's waitlist (a Google Sheet in production).
export type WaitlistEntry = WaitlistClient & {
  service: string;
  availability: Availability[];
  availabilityText?: string; // as written in the waitlist file, for display
  preferredStylist?: string;
  joinedAt: string; // YYYY-MM-DD
};

export type WaitlistInput = {
  slot: Slot;
  responseTimeoutMs?: number;
  // When the slot starts and when its day ends (ISO 8601), in the salon's
  // time zone. Booked and front-desk slots close themselves at closesAt.
  startsAt: string;
  closesAt: string;
  // When client texts may go out. Absent means any time (the demo override).
  textingHours?: TextingHours;
};

// "withdrawn": the opening was cancelled while this client held the offer.
// "not_sent": the offer text couldn't be sent, so the next client was tried.
export type OfferState = "sending" | "waiting" | "accepted" | "declined" | "timed_out" | "withdrawn" | "not_sent";

export type OfferRecord = {
  clientId: string;
  name: string;
  state: OfferState;
  offeredAt?: string;
  expiresAt?: string;
  respondedAt?: string;
};

export type TimelineEvent = {
  at: string;
  kind:
    | "info"
    | "offer"
    | "accepted"
    | "declined"
    | "timed_out"
    | "booked"
    | "staff"
    | "cancelled"
    | "handled"
    | "dismissed"
    | "error"
    | "closed"
    | "waiting";
  text: string;
};

export type WaitlistPhase = "offering" | "booking" | "booked" | "unfilled" | "cancelled";

export type WaitlistStatus = {
  slot: Slot;
  waitlist: WaitlistClient[];
  responseTimeoutMs: number;
  phase: WaitlistPhase;
  currentClientId?: string;
  bookedClientId?: string;
  staffNotified: boolean;
  // Set once the front desk marks an unfilled slot handled; the Workflow then ends.
  handled: boolean;
  // Set once the front desk dismisses the "Filled" notice for a booked slot; the Workflow then ends.
  filledNoticeDismissed: boolean;
  closesAt: string;
  // Set when a booked or front-desk slot reaches the end of its day without
  // the front desk closing it; the Workflow then ends.
  closedAutomatically: boolean;
  // The latest step that still failed after its retries ran out, e.g. the
  // waitlist file couldn't be read. Shown on the slot's page.
  error?: string;
  // Set while the Workflow waits for texting hours before the next offer.
  waitingUntil?: string;
  // Why the slot went to the front desk, when it isn't simply that nobody
  // took it (e.g. texting hours don't resume until after the slot starts).
  frontDeskReason?: string;
  offers: OfferRecord[];
  events: TimelineEvent[];
  message: string;
};

export type ReplyInput = {
  clientId: string;
  accept: boolean;
};

// Result of a front-desk action: cancelling an opening, marking it handled, or
// dismissing its "Filled" notice.
export type StaffActionResult = {
  message: string;
};

export type ReplyResult = {
  message: string;
};

export type OutboxMessage = {
  id: string;
  workflowId: string;
  kind: "offer" | "confirmation" | "staff_alert" | "staff_filled" | "rejection" | "cancellation";
  to: string;
  toName: string;
  body: string;
  sentAt: string;
};
