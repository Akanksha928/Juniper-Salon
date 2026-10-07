# Juniper Salon same-day waitlist

[![CI](https://github.com/Akanksha928/Juniper-Salon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Akanksha928/Juniper-Salon/actions/workflows/ci.yml)

When a client cancels, Juniper Salon wants that slot offered to people on its waitlist straight away. This app does that, one client at a time, on [Temporal](https://temporal.io), so the offer keeps going even if the app restarts mid-way.

## What it does

Each cancelled slot starts one Temporal Workflow, which:

1. **Finds who matches** on the waitlist: clients who want that service, are free at that day and time, and either have no stylist preference or prefer that stylist. Earliest to join go first.
2. **Texts them one at a time.** Each client gets the slot to themselves for a reply window. Only one person ever holds an open offer, so the slot can't be double-booked.
3. **YES** books the appointment, texts the client a confirmation and tells the front desk. **NO** or no reply moves on to the next client.
4. **If nobody takes it** (or nobody matches), the front desk is alerted to fill it by hand.

Replies that come late or out of turn are turned away and the client gets a "sorry, it's been offered to someone else" text. From the page, the front desk can:

- **Cancel an opening** before anyone says yes. Whoever holds the offer is told.
- **Mark handled** a slot they've filled by hand.
- **Dismiss** the "Filled" notice for a booked slot.

Booked and front-desk slots close automatically at the end of the slot's day if nobody dismisses or handles them, so old openings don't pile up.

If a step keeps failing, the Workflow stops retrying after 5 tries (about 15 seconds), shows the error on the slot's page and timeline, and carries on as best it can. Examples: the waitlist file can't be read, a text can't be sent, or the booking fails.

| What failed | What happens next |
| --- | --- |
| Reading the waitlist | The front desk is asked to fill the slot |
| Texting an offer | That client is skipped |
| Booking after a YES | The front desk is asked to book them |
| Any other text | The waitlist carries on |

## What's simulated

This is a working demo. The Temporal parts are real; these outside systems are stand-ins:

| In production | In this demo |
| --- | --- |
| **Square** reports the cancellation and takes the booking | You simulate a cancellation from the page (**Simulate a cancellation**). Bookings are logged, not written to Square. The page marks them "simulated — Square not updated". |
| **Texts** go to clients' phones through an SMS provider | Texts land in an in-memory outbox in the Worker, shown under **Simulated texts** on each slot's page. Nothing is actually sent, and the outbox empties when the Worker restarts. Use the **Reply YES / Reply NO** buttons to play each client. |
| **The waitlist** is the salon's Google Sheet | It's [`data/waitlist.csv`](data/waitlist.csv) (format below). It's read fresh for every cancellation, so edits apply to the next one without a restart. The page's **Waitlist** section shows what's in the file. |

**Duplicate texts:** if the Worker crashes mid-text, Temporal retries the Activity. The demo outbox ignores a message ID it has already recorded, so the client isn't texted twice. That check lives in Worker memory, though. A real SMS provider would need its own duplicate check, such as an idempotency key built from the same message ID, so a retry after a restart can't text someone twice.

## Run it

Requirements: Node.js 20 or newer and [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running).

```bash
npm install
npm run dev
```

This starts Temporal in Docker, then the Worker and the web app. Open:

- App: <http://localhost:3000>
- Temporal Web UI: <http://localhost:8233> (each slot's page links to its Workflow)

Stop with Ctrl+C. `npm run stop` also stops the Temporal container.

**Windows:** the same commands work in PowerShell, Command Prompt or Git Bash. Start Docker Desktop first. To change a setting for one run in PowerShell:

```powershell
$env:RESPONSE_TIMEOUT_SECONDS = "60"; npm run dev
```

In Git Bash or macOS/Linux, use `RESPONSE_TIMEOUT_SECONDS=60 npm run dev`.

To run the pieces in separate terminals instead (handy for stopping the Worker to see Temporal hold a slot safely):

```bash
npm run start:temporal  # Temporal in Docker
npm run dev:worker      # the Worker
npm run dev:api         # the web app and API
```

Other commands:

```bash
npm test          # Workflow, matching and CSV tests (no Docker needed)
npm run typecheck # Check TypeScript
```

### Reply window: 30 seconds in the demo, 15 minutes by default

Each client has a set time to reply before the offer moves on. The Workflow's default is **15 minutes**, the real-world setting. `npm run dev` passes **30 seconds** instead, so you can watch offers time out without waiting. Change it with `RESPONSE_TIMEOUT_SECONDS`.

## Settings

All optional, set as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `RESPONSE_TIMEOUT_SECONDS` | `30` | Reply window for each offer, in seconds. Read when the app starts; applies to slots opened after that. |
| `WAITLIST_CSV` | `data/waitlist.csv` | Path to the waitlist file. |
| `PORT` | `3000` | Port for the web app and API. |
| `OUTBOX_PORT` | `3001` | Port where the Worker serves the simulated text outbox to the API (local only). |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address. |

"Today" in texts and the end of a slot's day use the local time zone of the machine running the app, which is taken to be the salon's.

## Waitlist CSV format

[`data/waitlist.csv`](data/waitlist.csv) has a header row and one row per client. Open it in Excel, Google Sheets or a text editor. Column order doesn't matter, and blank rows are skipped.

| Column | Example | Notes |
| --- | --- | --- |
| `name` | Priya Shah | Required |
| `phone` | (555) 010-2231 | Required. Demo numbers only. |
| `service` | Cut & style | Required. Must match a service in the form exactly: `Cut & style`, `Color refresh` or `Blowout`. |
| `availability` | `Mon-Fri 09:00-17:00` | Required. Days as a range (`Mon-Fri`, which can wrap, like `Sat-Mon`) or a list (`Tue,Thu`), then a 24-hour time range. The start time is included and the end time isn't. Separate several windows with `;`, e.g. `Sat,Sun 10:00-18:00; Mon 17:00-21:00`. Quote the cell if it contains a comma. |
| `preferred_stylist` | Maya | Optional. Leave blank for any stylist. Otherwise `Maya`, `Jordan` or `Lena`. |
| `joined` | 2026-08-14 | Required. Earliest joiners are texted first (ties go alphabetically). `8/14/2026`, as Excel saves it, also works. |

If a row can't be read, the error names the row number and the problem. For example: `Waitlist CSV row 3: "joined" is empty`. The page's **Waitlist** section shows that error. A slot opened while the file is broken goes to the front desk with the error, once the retries run out.

## Repository map

- `src/workflows.ts`: the waitlist Workflow (offer loop, reply and front-desk handlers, retries, end-of-day close)
- `src/activities.ts`: Activities, the steps with side effects (reading the waitlist, texts, booking)
- `src/messages.ts`: the Query and Updates shared by the Workflow and the API
- `src/worker.ts`: the Worker, plus the HTTP endpoint for the simulated text outbox
- `src/api.ts`: the browser-facing API and Temporal Client
- `src/matching.ts`: who matches a slot, and in what order
- `src/waitlist.ts`: reads and checks `data/waitlist.csv`
- `src/outbox.ts`: the simulated SMS gateway (in-memory outbox)
- `src/shared.ts`: helpers shared by the Workflow, Activities and API (formatting, task queue name, defaults)
- `src/types.ts`: shared data types
- `public/`: the web page (front desk view and demo controls)
- `data/waitlist.csv`: the demo waitlist
- `scripts/dev.mjs`: `npm run dev`. It starts Temporal, the Worker and the API together.
- `tests/`: tests for the Workflow (including a replay test that catches non-deterministic Workflow changes), matching, and the CSV reader
- `compose.yml`: the local Temporal server
- `evidence/`: screenshot of a Workflow in the Temporal Web UI

## Further reading

- [Temporal TypeScript developer guide](https://docs.temporal.io/develop/typescript)
- [Workflows](https://docs.temporal.io/workflows) and [Activities](https://docs.temporal.io/activities)
- [Signals, Queries, and Updates](https://docs.temporal.io/encyclopedia/workflow-message-passing)
