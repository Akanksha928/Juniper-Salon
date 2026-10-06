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
};

// "withdrawn": the opening was cancelled while this client held the offer.
export type OfferState = "sending" | "waiting" | "accepted" | "declined" | "timed_out" | "withdrawn";

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
  kind: "info" | "offer" | "accepted" | "declined" | "timed_out" | "booked" | "staff" | "cancelled" | "handled";
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
  offers: OfferRecord[];
  events: TimelineEvent[];
  message: string;
};

export type ReplyInput = {
  clientId: string;
  accept: boolean;
};

// Result of a front-desk action: cancelling an opening or marking it handled.
export type StaffActionResult = {
  message: string;
};

export type ReplyResult = {
  message: string;
};

export type OutboxMessage = {
  id: string;
  workflowId: string;
  kind: "offer" | "confirmation" | "staff_alert" | "rejection" | "cancellation";
  to: string;
  toName: string;
  body: string;
  sentAt: string;
};
