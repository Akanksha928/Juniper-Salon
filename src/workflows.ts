import { condition, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";
import { cancelOpening, getWaitlistStatus, markHandled, replyToOffer } from "./messages";
import { DEFAULT_RESPONSE_TIMEOUT_MS, formatTime } from "./shared";
import type {
  OfferRecord,
  ReplyInput,
  TimelineEvent,
  WaitlistClient,
  WaitlistInput,
  WaitlistStatus,
} from "./types";

const {
  findMatchingClients,
  sendOffer,
  bookAppointment,
  sendConfirmation,
  sendCancellationNotice,
  notifyStaff,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", maximumInterval: "30 seconds" },
});

// One Workflow per open slot. Clients are offered the slot strictly one at a
// time, so at most one person can ever hold an open offer.
export async function waitlistWorkflow(input: WaitlistInput): Promise<WaitlistStatus> {
  const { slot } = input;
  const responseTimeoutMs = input.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const status: WaitlistStatus = {
    slot,
    waitlist: [],
    responseTimeoutMs,
    phase: "offering",
    staffNotified: false,
    handled: false,
    offers: [],
    events: [],
    message: "Starting the waitlist.",
  };
  let reply: ReplyInput | undefined;
  let cancelRequested = false;
  let handledRequested = false;

  // Workflow time (Date.now) is deterministic and safe to use here.
  const now = () => new Date().toISOString();
  const addEvent = (kind: TimelineEvent["kind"], text: string) => {
    status.events.push({ at: now(), kind, text });
    status.message = text;
  };

  setHandler(getWaitlistStatus, () => status);
  setHandler(
    replyToOffer,
    (incoming) => {
      reply = incoming;
      return {
        message: incoming.accept
          ? "Thanks! We're confirming your booking now."
          : "No problem, we'll offer it to the next person.",
      };
    },
    {
      // Rejected replies never reach the Workflow history, so a late or
      // out-of-turn "YES" cannot double-book the slot.
      validator: (incoming) => {
        if (cancelRequested) {
          throw new Error("Sorry, this opening is no longer available.");
        }
        if (status.phase === "booking" || status.phase === "booked") {
          throw new Error("Sorry, this slot has already been filled.");
        }
        if (status.phase === "unfilled") {
          throw new Error("Sorry, this offer has closed.");
        }
        if (incoming.clientId !== status.currentClientId) {
          throw new Error("Sorry, this offer isn't open for you right now.");
        }
        if (reply) {
          throw new Error("We already have your reply.");
        }
      },
    },
  );

  // The front desk can cancel the opening at any point before someone says
  // yes. The Workflow wakes up, tells whoever holds the offer, and ends.
  setHandler(
    cancelOpening,
    () => {
      cancelRequested = true;
      return { message: "Cancelling the opening." };
    },
    {
      validator: () => {
        if (cancelRequested) throw new Error("This opening is already cancelled.");
        if (reply?.accept || status.phase === "booking" || status.phase === "booked") {
          throw new Error("Too late to cancel: a client has already taken this slot.");
        }
        if (status.phase === "unfilled") {
          throw new Error("This opening has already been handed to the front desk.");
        }
      },
    },
  );

  // An unfilled slot stays open (and on everyone's openings list) until the
  // front desk marks it handled.
  setHandler(
    markHandled,
    () => {
      handledRequested = true;
      return { message: "Marked handled." };
    },
    {
      validator: () => {
        if (status.phase !== "unfilled" || !status.staffNotified) {
          throw new Error("Only slots waiting on the front desk can be marked handled.");
        }
        if (handledRequested) throw new Error("This slot is already marked handled.");
      },
    },
  );

  const cancel = async (holder?: WaitlistClient, offer?: OfferRecord): Promise<WaitlistStatus> => {
    status.currentClientId = undefined;
    status.phase = "cancelled";
    if (holder && offer) {
      offer.state = "withdrawn";
      offer.respondedAt = now();
      await sendCancellationNotice({ slot, client: holder });
    }
    // Added last: the UI treats this event as "cancellation finished".
    addEvent(
      "cancelled",
      holder
        ? `Opening cancelled. Told ${holder.name} it's no longer available.`
        : "Opening cancelled before anyone was texted.",
    );
    return status;
  };

  status.message = "Finding matching clients on the waitlist…";
  const waitlist = await findMatchingClients(slot);
  status.waitlist = waitlist;
  if (cancelRequested) return cancel();
  addEvent(
    "info",
    `${slot.stylist}'s ${formatTime(slot.time)} ${slot.service} opened up. ` +
      `${waitlist.length} matching client${waitlist.length === 1 ? "" : "s"} on the waitlist.`,
  );

  for (const client of waitlist) {
    if (cancelRequested) return cancel();
    const offer: OfferRecord = { clientId: client.clientId, name: client.name, state: "sending" };
    status.offers.push(offer);
    status.message = `Texting ${client.name}…`;
    await sendOffer({ slot, client, responseTimeoutMs });
    if (cancelRequested) return cancel(client, offer);

    reply = undefined;
    const offeredAt = Date.now();
    offer.state = "waiting";
    offer.offeredAt = new Date(offeredAt).toISOString();
    offer.expiresAt = new Date(offeredAt + responseTimeoutMs).toISOString();
    status.currentClientId = client.clientId;
    addEvent("offer", `Texted ${client.name}. Waiting for a reply.`);

    const replied = await condition(() => reply !== undefined || cancelRequested, responseTimeoutMs);
    status.currentClientId = undefined;
    // A NO that arrived just before the cancel still counts as a NO.
    if (cancelRequested && reply === undefined) return cancel(client, offer);
    offer.respondedAt = now();

    if (!replied) {
      offer.state = "timed_out";
      addEvent("timed_out", `${client.name} didn't reply in time. Moving on.`);
      continue;
    }
    if (!reply!.accept) {
      offer.state = "declined";
      addEvent("declined", `${client.name} passed on the slot.`);
      continue;
    }

    offer.state = "accepted";
    status.phase = "booking";
    status.bookedClientId = client.clientId;
    addEvent("accepted", `${client.name} said yes. Booking the appointment.`);
    await bookAppointment({ slot, client });
    await sendConfirmation({ slot, client });
    status.phase = "booked";
    addEvent("booked", `Booked ${client.name} for ${formatTime(slot.time)} with ${slot.stylist}.`);
    return status;
  }

  if (cancelRequested) return cancel();
  status.phase = "unfilled";
  addEvent(
    "staff",
    waitlist.length === 0
      ? "Nobody on the waitlist matches this slot. Notifying the front desk."
      : "Nobody on the waitlist took the slot. Notifying the front desk.",
  );
  await notifyStaff({ slot, clientsOffered: waitlist.length });
  status.staffNotified = true;
  addEvent("staff", "Front desk notified to fill the slot manually.");

  await condition(() => handledRequested);
  status.handled = true;
  addEvent("handled", "Front desk marked the slot handled.");
  return status;
}
