const $ = (selector) => document.querySelector(selector);
const els = {
  banners: $("#banners"),
  home: $("#home"),
  openings: $("#openings-list"),
  filledNotices: $("#filled-notices"),
  board: $("#board"),
  form: $("#slot-form"),
  formError: $("#form-error"),
  openSlot: $("#open-slot"),
  roster: $("#roster-list"),
  rosterEmpty: $("#roster-empty"),
  setup: $("#setup"),
  toggleSetup: $("#toggle-setup"),
  waitlist: $("#waitlist"),
  toggleWaitlist: $("#toggle-waitlist"),
  waitlistRows: $("#waitlist-rows"),
  slotTitle: $("#slot-title"),
  slotMessage: $("#slot-message"),
  phasePill: $("#phase-pill"),
  slotActions: $("#slot-actions"),
  workflowLink: $("#workflow-link"),
  clients: $("#clients"),
  timeline: $("#timeline"),
  outbox: $("#outbox"),
  outboxNote: $("#outbox-note"),
  newSlot: $("#new-slot"),
  toast: $("#toast"),
};

let workflowId;
let status;
// No Worker is answering, so the slot is paused (Temporal still holds it).
let workerOffline = false;
// Temporal or this app's server can't be reached at all.
let systemUnavailable = false;
let pollTimer;
let polling = false;
let toastTimer;
let openingsTimer;
let matchesRequest = 0;
// Openings whose "Cancel opening" was clicked and await "Are you sure?".
const confirmingCancel = new Set();

// Shown wherever a booking appears: the demo doesn't write to Square.
const SIMULATED_BOOKING = "(simulated — Square not updated)";

const PHASE_LABELS = {
  offering: "Offering",
  booking: "Booking",
  booked: "Booked",
  unfilled: "Unfilled",
  cancelled: "Cancelled",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatSlotTime(date, time) {
  const when = new Date(`${date}T${time}`);
  const day = when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} · ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function isFinished(s) {
  return s && (
    s.phase === "booked" ||
    // Booked and front-desk slots close themselves at the end of their day.
    s.closedAutomatically ||
    // An unfilled slot stays open until the front desk marks it handled.
    (s.phase === "unfilled" && s.handled) ||
    // The Workflow adds its "cancelled" event after texting the offer holder.
    (s.phase === "cancelled" && s.events.at(-1)?.kind === "cancelled")
  );
}

function formatRemaining(expiresAt) {
  const seconds = Math.ceil(Math.max(0, new Date(expiresAt).getTime() - Date.now()) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Front-desk actions ("cancel", "handled") are messages to the running
// Workflow, so every browser sees the result.
async function staffAction(id, action, doneMessage) {
  try {
    const response = await fetch(`/api/slots/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    const body = await response.json();
    showToast(response.ok ? doneMessage : body.error, !response.ok);
    return response.ok;
  } catch {
    showToast("Could not reach the salon server.", true);
    return false;
  }
}

// Skips the write when nothing changed, so a periodic re-render doesn't
// swap out a button mid-click.
const renderedHtml = new WeakMap();
function setHtml(el, html) {
  if (renderedHtml.get(el) === html) return;
  el.innerHTML = html;
  renderedHtml.set(el, html);
}

// Buttons for an opening, shared by the openings list and the detail view.
function slotActionsHtml(id, s) {
  const attrs = (action) => `type="button" data-action="${action}" data-id="${escapeHtml(id)}"`;
  if (s?.phase === "offering") {
    return confirmingCancel.has(id)
      ? `<span class="confirm-text">Are you sure?</span>
         <button ${attrs("confirm-cancel")} class="danger">Yes, cancel opening</button>
         <button ${attrs("keep")} class="quiet">Keep it</button>`
      : `<button ${attrs("cancel")} class="danger">Cancel opening</button>`;
  }
  if (s?.phase === "unfilled" && s.staffNotified && !s.handled) {
    return `<button ${attrs("handled")} class="quiet">Mark handled</button>`;
  }
  return "";
}

function rerender() {
  if (workflowId) renderBoard();
  else renderOpenings();
}

async function handleSlotAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  event.preventDefault();
  const id = button.dataset.id;
  switch (button.dataset.action) {
    case "cancel":
      confirmingCancel.add(id);
      return rerender();
    case "keep":
      confirmingCancel.delete(id);
      return rerender();
    case "confirm-cancel":
      button.disabled = true;
      await staffAction(id, "cancel", "Opening cancelled.");
      confirmingCancel.delete(id);
      return workflowId ? poll() : refreshOpenings();
    case "dismiss":
      button.disabled = true;
      if (await staffAction(id, "dismiss", "Notice dismissed.")) await refreshOpenings();
      else button.disabled = false;
      return;
    case "handled":
      button.disabled = true;
      if (!(await staffAction(id, "handled", "Marked handled and removed from openings."))) {
        button.disabled = false;
        return;
      }
      if (workflowId) location.hash = "";
      else await refreshOpenings();
  }
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? " error" : ""}`;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
}

// ---------- Openings ----------

// The list comes from Temporal through the API, so every browser sees the
// same openings: undefined until the first load, null if it failed. Filled
// slots leave the list but show a notice until someone dismisses it.
let openings;
let openingsError;
let filled = [];
let refreshingOpenings = false;

function openingState(s) {
  if (!s) return { key: "queued", label: "Paused" }; // listed, but no Worker to give live status
  if (s.phase === "unfilled") return { key: "unfilled", label: "Needs front desk" };
  return { key: "offering", label: "Texting a client" };
}

function renderFilledNotices() {
  setHtml(els.filledNotices, filled
    .map(({ workflowId: id, slot, status: s }) => {
      const client = s.waitlist.find((c) => c.clientId === s.bookedClientId);
      const when = new Date(`${slot.date}T${slot.time}`);
      const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const day = when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
      return `<div class="banner success notice"><span class="banner-icon">✓</span>
        <div><a href="#${encodeURIComponent(id)}"><strong>Filled: ${escapeHtml(client?.name ?? "A client")} took
          ${escapeHtml(slot.stylist)}'s ${escapeHtml(time)} ${escapeHtml(slot.service)}</strong></a>
          on ${escapeHtml(day)} ${SIMULATED_BOOKING}</div>
        <button type="button" class="quiet" data-action="dismiss" data-id="${escapeHtml(id)}">Dismiss</button>
      </div>`;
    })
    .join(""));
}

function renderOpenings() {
  renderFilledNotices();
  if (openings === undefined) {
    setHtml(els.openings, `<li class="empty">Loading openings…</li>`);
    return;
  }
  if (openings === null) {
    setHtml(els.openings, `<li class="empty">${escapeHtml(openingsError ?? "Could not load openings.")} Retrying…</li>`);
    return;
  }
  if (!openings.length) {
    setHtml(els.openings, `<li class="empty">No openings right now.</li>`);
    return;
  }
  const sorted = [...openings].sort((a, b) =>
    `${a.slot.date}T${a.slot.time}`.localeCompare(`${b.slot.date}T${b.slot.time}`),
  );
  setHtml(els.openings, sorted
    .map(({ workflowId: id, slot: o, status: s }) => {
      const state = openingState(s);
      const holder = s?.waitlist?.find((c) => c.clientId === s.currentClientId);
      const offer = s?.offers?.find((x) => x.clientId === s.currentClientId);
      const summary = s ? offerSummary(s) : "";
      const offerLine = holder && offer?.expiresAt
        ? `<p class="opening-offer" data-name="${escapeHtml(holder.name)}" data-expires="${offer.expiresAt}"></p>`
        : "";
      const actions = slotActionsHtml(id, s);
      return `<li class="opening">
        <a class="opening-link" href="#${encodeURIComponent(id)}">
          <div>
            <p class="opening-title">${escapeHtml(o.stylist)} · ${escapeHtml(o.service)}</p>
            <p class="opening-time">${escapeHtml(formatSlotTime(o.date, o.time))}</p>
            ${offerLine}
            ${summary ? `<p class="opening-summary">${summary}</p>` : ""}
            ${s?.error ? `<p class="opening-error">${escapeHtml(s.error)}</p>` : ""}
          </div>
          <span class="pill ${state.key}">${state.label}</span>
        </a>
        ${actions ? `<div class="slot-actions">${actions}</div>` : ""}
      </li>`;
    })
    .join(""));
  updateOfferTimers();
}

// "1 declined · 1 no reply · 2 left", where "left" is who hasn't been texted yet.
function offerSummary(s) {
  // With an error, the waitlist may be empty only because it couldn't be read.
  if (!s.waitlist.length) return s.phase === "offering" || s.error ? "" : "No matching clients";
  const count = (state) => s.offers.filter((o) => o.state === state).length;
  const left = s.waitlist.filter((c) => !s.offers.some((o) => o.clientId === c.clientId)).length;
  const parts = [];
  if (count("declined")) parts.push(`${count("declined")} declined`);
  if (count("timed_out")) parts.push(`${count("timed_out")} no reply`);
  if (count("not_sent")) parts.push(`${count("not_sent")} couldn't be texted`);
  if (s.phase === "offering") parts.push(`${left} left`);
  return parts.join(" · ");
}

function updateOfferTimers() {
  for (const el of document.querySelectorAll(".opening-offer")) {
    el.textContent = `Offered to ${el.dataset.name} · ${formatRemaining(el.dataset.expires)} left`;
  }
}

els.openings.addEventListener("click", handleSlotAction);
els.filledNotices.addEventListener("click", handleSlotAction);

async function refreshOpenings() {
  if (refreshingOpenings) return;
  refreshingOpenings = true;
  try {
    const response = await fetch("/api/slots");
    const body = await response.json();
    openings = response.ok ? body.openings : null;
    openingsError = response.ok ? undefined : body.error;
    filled = response.ok ? body.filled : filled;
  } catch {
    openings = null;
    openingsError = "Could not reach the salon server.";
  } finally {
    refreshingOpenings = false;
  }
  if (!workflowId) renderOpenings();
}

function startOpenings() {
  renderOpenings();
  refreshOpenings();
  openingsTimer = setInterval(refreshOpenings, 2000);
}

function stopOpenings() {
  clearInterval(openingsTimer);
  openingsTimer = undefined;
}

// ---------- Setup ----------

function setSetupOpen(open) {
  els.setup.hidden = !open;
  els.toggleSetup.setAttribute("aria-expanded", String(open));
}

els.toggleSetup.addEventListener("click", () => setSetupOpen(els.setup.hidden));

// ---------- Waitlist ----------

// Loaded each time it's opened, so edits to data/waitlist.csv show up.
els.toggleWaitlist.addEventListener("click", async () => {
  const open = els.waitlist.hidden;
  els.waitlist.hidden = !open;
  els.toggleWaitlist.setAttribute("aria-expanded", String(open));
  if (!open) return;
  const row = (text) => `<tr><td colspan="5" class="empty">${text}</td></tr>`;
  els.waitlistRows.innerHTML = row("Loading…");
  try {
    const response = await fetch("/api/waitlist");
    const body = await response.json();
    if (!response.ok) {
      els.waitlistRows.innerHTML = row(escapeHtml(body.error ?? "Could not load the waitlist."));
      return;
    }
    els.waitlistRows.innerHTML = body.length
      ? body.map((c) => `<tr>
          <td>${escapeHtml(c.name)}<small>${escapeHtml(c.phone)}</small></td>
          <td>${escapeHtml(c.service)}</td>
          <td>${escapeHtml(c.availability)}</td>
          <td>${c.preferredStylist ? escapeHtml(c.preferredStylist) : "Any"}</td>
          <td>${escapeHtml(formatJoined(c.joinedAt))}</td>
        </tr>`).join("")
      : row("Nobody is on the waitlist.");
  } catch {
    els.waitlistRows.innerHTML = row("Could not reach the salon server.");
  }
});

function initForm() {
  const now = new Date();
  now.setMinutes(Math.ceil((now.getMinutes() + 1) / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  els.form.date.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  els.form.time.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  refreshMatches();
}

function formatJoined(date) {
  return new Date(`${date}T00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Preview who the Workflow will text for the selected slot, in order.
async function refreshMatches() {
  const form = new FormData(els.form);
  const params = new URLSearchParams(["stylist", "service", "date", "time"].map((k) => [k, form.get(k)]));
  const request = ++matchesRequest;
  let matches;
  try {
    const response = await fetch(`/api/matches?${params}`);
    matches = response.ok ? await response.json() : undefined;
  } catch {}
  if (request !== matchesRequest) return; // a newer selection is loading
  els.roster.innerHTML = (matches ?? [])
    .map((c) => `<li><div>${escapeHtml(c.name)}<small>${
      c.preferredStylist ? `Prefers ${escapeHtml(c.preferredStylist)}` : "Any stylist"
    } · joined ${escapeHtml(formatJoined(c.joinedAt))}</small></div></li>`)
    .join("");
  els.rosterEmpty.hidden = Boolean(matches?.length);
  els.rosterEmpty.textContent = matches
    ? "Nobody on the waitlist matches this slot. The front desk will be alerted right away."
    : "Could not load matching clients.";
}

els.form.addEventListener("input", refreshMatches);

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.formError.hidden = true;
  els.openSlot.disabled = true;
  const form = new FormData(els.form);
  const slot = {
    stylist: form.get("stylist"),
    service: form.get("service"),
    date: form.get("date"),
    time: form.get("time"),
  };
  try {
    const response = await fetch("/api/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slot),
    });
    const body = await response.json();
    if (!response.ok) {
      els.formError.textContent = body.error ?? "Could not open the slot.";
      els.formError.hidden = false;
      return;
    }
    setSetupOpen(false);
    location.hash = body.workflowId;
  } catch {
    els.formError.textContent = "Could not reach the salon server.";
    els.formError.hidden = false;
  } finally {
    els.openSlot.disabled = false;
  }
});

els.newSlot.addEventListener("click", () => {
  location.hash = "";
});

// ---------- Board ----------

// Every matched client's status, in waitlist order: history first, then who
// has the offer, then who's still up next.
function clientState(client) {
  const offer = status.offers.find((o) => o.clientId === client.clientId);
  if (!offer) {
    return status.phase === "offering" ? { key: "queued", label: "Up next" } : { key: "skipped", label: "Not needed" };
  }
  switch (offer.state) {
    case "sending": return { key: "waiting", label: "Has the offer" };
    case "waiting": return { key: "waiting", label: "Has the offer", expiresAt: offer.expiresAt };
    case "accepted": return status.phase === "booked"
      ? { key: "accepted", label: "Booked", simulated: true }
      : { key: "accepted", label: "Accepted" };
    case "declined": return { key: "declined", label: "Declined" };
    case "timed_out": return { key: "timed_out", label: "No reply" };
    case "withdrawn": return { key: "skipped", label: "Offer withdrawn" };
    case "not_sent": return { key: "not_sent", label: "Couldn't text" };
  }
}

function renderBanners() {
  const banners = [];
  // Written for front desk staff; the collapsed note is for whoever runs the system.
  if (systemUnavailable) {
    banners.push(`<div class="banner error"><span class="banner-icon">!</span><div>
      <strong>The waitlist system isn't responding</strong>This page can't update right now. Nothing in progress is
      lost, and the page catches up by itself once it's back. If this lasts more than a few minutes, let whoever
      looks after the system know.
      <details class="tech-note"><summary>Technical details</summary>The app can't reach its server or Temporal.
      Check that Docker Desktop is running, then start Temporal with <code>npm run start:temporal</code>.</details>
      </div></div>`);
  }
  if (status?.error) {
    banners.push(`<div class="banner error"><span class="banner-icon">!</span><div>
      <strong>Something went wrong</strong>${escapeHtml(status.error)}</div></div>`);
  }
  if (status?.closedAutomatically) {
    banners.push(`<div class="banner cancelled"><span class="banner-icon">✓</span><div>
      <strong>Closed at the end of the day</strong>The slot's day is over, so it was closed automatically and taken
      off the openings list.</div></div>`);
  }
  if (workerOffline) {
    banners.push(`<div class="banner offline"><span class="banner-icon">⏸</span><div>
      <strong>The waitlist is paused for a moment</strong>Texts and replies are on hold. Nothing is lost: it
      picks up exactly where it left off, including any reply timers. If this lasts more than a few minutes, let
      whoever looks after the system know.
      <details class="tech-note"><summary>Technical details</summary>No Worker is running. Temporal is holding
      this Workflow safely. Start the Worker with <code>npm run dev:worker</code>.</details></div></div>`);
  }
  if (status?.phase === "unfilled" && status.handled) {
    banners.push(`<div class="banner cancelled"><span class="banner-icon">✓</span><div>
      <strong>Handled by the front desk</strong>This slot is closed and off the openings list.</div></div>`);
  } else if (status?.phase === "unfilled" && !status.closedAutomatically) {
    const slotName = `${escapeHtml(status.slot.stylist)}'s ${escapeHtml(formatSlotTime(status.slot.date, status.slot.time))}
      ${escapeHtml(status.slot.service)}`;
    const why = status.error
      ? `The waitlist couldn't finish filling ${slotName} on its own (see above).`
      : `Nobody on the waitlist ${status.waitlist.length ? "took" : "matches"} ${slotName}.`;
    banners.push(`<div class="banner staff"><span class="banner-icon">⚠</span><div>
      <strong>Front desk: this slot needs you</strong>${why}
      ${status.staffNotified ? "Staff have been alerted." : "Alerting staff…"}</div></div>`);
  }
  if (status?.phase === "cancelled") {
    banners.push(`<div class="banner cancelled"><span class="banner-icon">✕</span><div>
      <strong>Opening cancelled</strong>The waitlist has stopped for this slot. Any replies now are turned away.</div></div>`);
  }
  if (status?.phase === "booked") {
    const booked = status.waitlist.find((c) => c.clientId === status.bookedClientId);
    banners.push(`<div class="banner success"><span class="banner-icon">✓</span><div>
      <strong>Slot filled</strong>${escapeHtml(booked?.name ?? "A client")} is booked ${SIMULATED_BOOKING}
      and has been sent a confirmation.</div></div>`);
  }
  els.banners.innerHTML = banners.join("");
}

function renderBoard() {
  renderBanners();
  if (!status) return;
  const { slot } = status;
  els.slotTitle.textContent = `${slot.stylist} · ${slot.service}`;
  const bookingNote = status.phase === "booking" || status.phase === "booked" ? ` ${SIMULATED_BOOKING}` : "";
  els.slotMessage.textContent = `${formatSlotTime(slot.date, slot.time)} — ${status.message}${bookingNote}`;
  els.phasePill.textContent = status.phase === "booked"
    ? `${PHASE_LABELS.booked} ${SIMULATED_BOOKING}`
    : PHASE_LABELS[status.phase];
  els.phasePill.className = `pill ${status.phase}`;
  setHtml(els.slotActions, slotActionsHtml(workflowId, status));
  els.workflowLink.textContent = workflowId;
  els.workflowLink.href = `http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(workflowId)}`;

  els.clients.innerHTML = status.waitlist
    .map((client) => {
      const state = clientState(client);
      const offer = status.offers.find((o) => o.clientId === client.clientId);
      const isCurrent = status.currentClientId === client.clientId;
      const won = status.bookedClientId === client.clientId;
      const replied = offer?.state === "accepted" || offer?.state === "declined";
      const actions = replied
        ? ""
        : `<div class="client-actions">
            <button class="accept" data-client="${client.clientId}" data-accept="true">Reply YES</button>
            <button class="decline" data-client="${client.clientId}" data-accept="false">Reply NO</button>
          </div>`;
      const countdown = isCurrent && offer?.expiresAt
        ? `<div class="countdown" data-expires="${offer.expiresAt}">
             <div class="countdown-bar"><div class="countdown-fill"></div></div>
             <p class="countdown-text"></p>
           </div>`
        : "";
      return `<li class="client${isCurrent ? " current" : ""}${won ? " won" : ""}">
        <div class="client-row">
          <div>
            <p class="client-name">${escapeHtml(client.name)}</p>
            <p class="client-phone">${escapeHtml(client.phone)}</p>
          </div>
          <div class="client-status">
            <span class="pill ${state.key}">${state.label}${
              state.expiresAt ? ` · <span class="pill-time" data-expires="${state.expiresAt}"></span> left` : ""
            }</span>
            ${state.simulated ? `<small class="sim-note">${SIMULATED_BOOKING}</small>` : ""}
          </div>
        </div>
        ${countdown}
        ${actions}
      </li>`;
    })
    .join("");
  if (!status.waitlist.length) {
    els.clients.innerHTML = `<li class="empty">${
      status.phase === "unfilled" ? "Nobody on the waitlist matches this slot." : "Finding matching clients…"
    }</li>`;
  }

  els.timeline.innerHTML = status.events
    .map((e) => {
      const note = e.kind === "accepted" || e.kind === "booked" ? ` ${SIMULATED_BOOKING}` : "";
      return `<li class="${e.kind}"><time>${formatClock(e.at)}</time>${escapeHtml(e.text)}${note}</li>`;
    })
    .join("");
  updateCountdowns();
}

function renderOutbox(outbox) {
  els.outboxNote.textContent = outbox.available ? "" : "· can't load texts right now";
  if (!outbox.messages.length) {
    els.outbox.innerHTML = `<li class="empty">${outbox.available ? "No texts yet." : "Outbox resets when the Worker restarts."}</li>`;
    return;
  }
  els.outbox.innerHTML = outbox.messages
    .map((m) => `<li class="sms ${m.kind}">
      <div class="sms-to"><span>To ${escapeHtml(m.toName)}</span><span>${formatClock(m.sentAt)}</span></div>
      ${escapeHtml(m.body)}
      ${m.kind === "confirmation" ? `<small class="sim-note">${SIMULATED_BOOKING}</small>` : ""}</li>`)
    .join("");
}

function updateCountdowns() {
  if (!status) return;
  for (const el of document.querySelectorAll(".pill-time")) el.textContent = formatRemaining(el.dataset.expires);
  for (const el of document.querySelectorAll(".countdown")) {
    const remainingMs = Math.max(0, new Date(el.dataset.expires).getTime() - Date.now());
    const fraction = remainingMs / status.responseTimeoutMs;
    el.querySelector(".countdown-fill").style.width = `${(fraction * 100).toFixed(1)}%`;
    const seconds = Math.ceil(remainingMs / 1000);
    el.querySelector(".countdown-text").textContent = remainingMs > 0
      ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left to reply`
      : "Time's up, moving to the next client…";
  }
}

els.slotActions.addEventListener("click", handleSlotAction);

els.clients.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-client]");
  if (!button) return;
  const buttons = button.parentElement.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  const clientName = status.waitlist.find((c) => c.clientId === button.dataset.client)?.name ?? "Client";
  try {
    const response = await fetch(`/api/slots/${encodeURIComponent(workflowId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: button.dataset.client, accept: button.dataset.accept === "true" }),
    });
    const body = await response.json();
    showToast(`${clientName}: ${response.ok ? body.message : body.error}`, !response.ok);
  } catch {
    showToast("Could not reach the salon server.", true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    await poll();
  }
});

// ---------- Polling ----------

async function poll() {
  if (!workflowId || polling) return;
  polling = true;
  const id = workflowId;
  try {
    const [statusResponse, outboxResponse] = await Promise.all([
      fetch(`/api/slots/${encodeURIComponent(id)}`),
      fetch(`/api/outbox?workflowId=${encodeURIComponent(id)}`),
    ]);
    if (id !== workflowId) return; // user moved on
    if (statusResponse.status === 404) {
      showToast("That slot could not be found.", true);
      location.hash = "";
      return;
    }
    const statusBody = await statusResponse.json();
    workerOffline = statusResponse.status === 503 && Boolean(statusBody.workerOffline);
    systemUnavailable = statusResponse.status === 503 && !statusBody.workerOffline;
    if (statusResponse.ok) status = statusBody;
    renderBoard();
    renderOutbox(await outboxResponse.json());
    if (isFinished(status) && !workerOffline && !systemUnavailable) stopPolling();
  } catch {
    // This app's own server didn't answer.
    workerOffline = false;
    systemUnavailable = true;
    renderBanners();
  } finally {
    polling = false;
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function route() {
  stopPolling();
  stopOpenings();
  confirmingCancel.clear();
  workflowId = decodeURIComponent(location.hash.slice(1)) || undefined;
  status = undefined;
  workerOffline = false;
  systemUnavailable = false;
  els.banners.innerHTML = "";
  els.home.hidden = Boolean(workflowId);
  els.board.hidden = !workflowId;
  if (!workflowId) {
    startOpenings();
    return;
  }
  els.slotTitle.textContent = "Loading…";
  els.slotMessage.textContent = "";
  setHtml(els.slotActions, "");
  els.clients.innerHTML = "";
  els.timeline.innerHTML = "";
  els.outbox.innerHTML = "";
  pollTimer = setInterval(poll, 1000);
  poll();
}

async function init() {
  initForm();
  window.addEventListener("hashchange", route);
  // Chrome slows timers in background tabs (down to once a minute), so catch
  // up as soon as the tab is visible again.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (workflowId) poll();
    else refreshOpenings();
  });
  setInterval(() => {
    updateCountdowns();
    updateOfferTimers();
  }, 250);
  route();
}

init();
