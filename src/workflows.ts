import { ActivityFailure, condition, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities";
import { cancelOpening, dismissFilledNotice, getWaitlistStatus, markHandled, replyToOffer } from "./messages";
import { DEFAULT_RESPONSE_TIMEOUT_MS, describeSalonTime, formatTime, nextTextingTime } from "./shared";
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
  notifyFrontDeskFilled,
  sendCancellationNotice,
  notifyStaff,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  // Five tries over about 15 seconds (waits of 1, 2, 4 and 8 seconds). After
  // that the Workflow stops retrying, shows the error on the slot's page, and
  // carries on as best it can.
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 5 },
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
    filledNoticeDismissed: false,
    closesAt: input.closesAt,
    closedAutomatically: false,
    offers: [],
    events: [],
    message: "Starting the waitlist.",
  };
  let reply: ReplyInput | undefined;
  let cancelRequested = false;
  let handledRequested = false;
  let dismissRequested = false;

  // Workflow time (Date.now) is deterministic and safe to use here.
  const now = () => new Date().toISOString();
  const addEvent = (kind: TimelineEvent["kind"], text: string) => {
    status.events.push({ at: now(), kind, text });
    status.message = text;
  };

  // Records an Activity that failed after all its retries, so the front desk
  // can see what went wrong. Anything else is a bug and fails the Workflow Task.
  const recordFailure = (what: string, error: unknown): void => {
    if (!(error instanceof ActivityFailure)) throw error;
    status.error = `${what}: ${error.cause?.message ?? error.message}`;
    addEvent("error", status.error);
  };

  // For texts that don't change the outcome: if one can't be sent, the
  // waitlist carries on and the error shows on the slot's page. True if sent.
  const sendBestEffort = async (what: string, send: () => Promise<void>): Promise<boolean> => {
    try {
      await send();
      return true;
    } catch (error) {
      recordFailure(what, error);
      return false;
    }
  };

  // Lena's rule: client texts only go out in opening hours, and an offer only
  // if its whole reply window ends by closing. Waits on a durable timer until
  // then (the front desk can still cancel meanwhile). If texting can't resume
  // until after the slot starts, the slot goes to the front desk instead.
  const waitForTextingTime = async (): Promise<"ok" | "cancelled" | { tooLate: string }> => {
    const hours = input.textingHours;
    if (!hours) return "ok";
    const now = Date.now();
    const sendAt = nextTextingTime(now, responseTimeoutMs, hours);
    if (sendAt <= now) return "ok";
    const when = describeSalonTime(sendAt, hours.timeZone);
    if (sendAt >= Date.parse(input.startsAt)) {
      return { tooLate: `Texting hours don't resume until ${when}, after the slot starts` };
    }
    status.waitingUntil = new Date(sendAt).toISOString();
    addEvent("waiting", `Waiting until ${when} to ${status.offers.length ? "resume" : "start"} texting.`);
    await condition(() => cancelRequested, sendAt - now);
    status.waitingUntil = undefined;
    return cancelRequested ? "cancelled" : "ok";
  };

  // Booked and front-desk slots wait for the front desk, but no later than
  // the end of the slot's day. True if the front desk acted in time.
  const waitForFrontDeskUntilClose = async (done: () => boolean): Promise<boolean> => {
    const acted = await condition(done, Math.max(1, Date.parse(input.closesAt) - Date.now()));
    if (!acted) {
      status.closedAutomatically = true;
      addEvent("closed", "The slot's day is over, so it was closed automatically.");
    }
    return acted;
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

  // A booked slot stays open, showing a "Filled" notice on every browser,
  // until the front desk dismisses it.
  setHandler(
    dismissFilledNotice,
    () => {
      dismissRequested = true;
      return { message: "Notice dismissed." };
    },
    {
      validator: () => {
        if (status.phase !== "booked") throw new Error("Only filled slots have a notice to dismiss.");
        if (dismissRequested) throw new Error("This notice is already dismissed.");
      },
    },
  );

  const cancel = async (holder?: WaitlistClient, offer?: OfferRecord): Promise<WaitlistStatus> => {
    status.currentClientId = undefined;
    status.phase = "cancelled";
    let told = false;
    if (holder && offer) {
      offer.state = "withdrawn";
      offer.respondedAt = now();
      told = await sendBestEffort(`Couldn't tell ${holder.name} the opening was cancelled`, () =>
        sendCancellationNotice({ slot, client: holder }),
      );
    }
    // Added last: the UI treats this event as "cancellation finished".
    addEvent(
      "cancelled",
      !holder
        ? "Opening cancelled before anyone was texted."
        : told
          ? `Opening cancelled. Told ${holder.name} it's no longer available.`
          : "Opening cancelled.",
    );
    return status;
  };

  status.message = "Finding matching clients on the waitlist…";
  let waitlist: WaitlistClient[] = [];
  // Set when the slot goes to the front desk because a step failed, rather
  // than because nobody took it.
  let problem: string | undefined;
  try {
    waitlist = await findMatchingClients(slot);
  } catch (error) {
    recordFailure("Couldn't read the waitlist", error);
    problem = status.error;
  }
  status.waitlist = waitlist;
  if (cancelRequested) return cancel();
  if (!problem) {
    addEvent(
      "info",
      `${slot.stylist}'s ${formatTime(slot.time)} ${slot.service} opened up. ` +
        `${waitlist.length} matching client${waitlist.length === 1 ? "" : "s"} on the waitlist.`,
    );
  }

  for (const client of waitlist) {
    if (cancelRequested) return cancel();
    const ready = await waitForTextingTime();
    if (ready === "cancelled") return cancel();
    if (ready !== "ok") {
      problem = ready.tooLate;
      addEvent("staff", `${problem}.`);
      break;
    }
    const offer: OfferRecord = { clientId: client.clientId, name: client.name, state: "sending" };
    status.offers.push(offer);
    status.message = `Texting ${client.name}…`;
    try {
      await sendOffer({ slot, client, responseTimeoutMs });
    } catch (error) {
      offer.state = "not_sent";
      recordFailure(`Couldn't text ${client.name}, so moving on`, error);
      continue;
    }
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
    try {
      await bookAppointment({ slot, client });
    } catch (error) {
      // They said yes but aren't booked, so the front desk has to step in.
      status.bookedClientId = undefined;
      recordFailure(`${client.name} said yes, but the booking failed`, error);
      problem = status.error;
      break;
    }
    await sendBestEffort(`Couldn't text ${client.name} their confirmation`, () =>
      sendConfirmation({ slot, client }),
    );
    await sendBestEffort("Couldn't tell the front desk the slot was filled", () =>
      notifyFrontDeskFilled({ slot, client }),
    );
    status.phase = "booked";
    addEvent("booked", `Booked ${client.name} for ${formatTime(slot.time)} with ${slot.stylist}.`);

    if (await waitForFrontDeskUntilClose(() => dismissRequested)) {
      status.filledNoticeDismissed = true;
      addEvent("dismissed", "Front desk dismissed the filled notice.");
    }
    return status;
  }

  if (cancelRequested) return cancel();
  status.phase = "unfilled";
  if (problem) status.frontDeskReason = problem;
  addEvent(
    "staff",
    problem
      ? "Notifying the front desk to fill the slot manually."
      : waitlist.length === 0
        ? "Nobody on the waitlist matches this slot. Notifying the front desk."
        : "Nobody on the waitlist took the slot. Notifying the front desk.",
  );
  const clientsOffered = status.offers.filter((o) => o.state !== "not_sent").length;
  const alerted = await sendBestEffort("Couldn't alert the front desk", () =>
    notifyStaff({ slot, clientsOffered, problem }),
  );
  // Set even if the alert failed: the slot still shows as needing the front
  // desk on everyone's openings list, and they can still mark it handled.
  status.staffNotified = true;
  if (alerted) addEvent("staff", "Front desk notified to fill the slot manually.");

  if (await waitForFrontDeskUntilClose(() => handledRequested)) {
    status.handled = true;
    addEvent("handled", "Front desk marked the slot handled.");
  }
  return status;
}
