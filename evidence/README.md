# Evidence

Screenshots of the waitlist running locally, taken by a headless Chrome (Playwright) script at a 1440px-wide window on Oct 6, 2026.

How they were made:

- **Fresh start:** `docker compose down -v`, so Temporal had no earlier data.
- **Running parts:** Temporal, the Worker, and the API.
- **Reply window:** 60 seconds, so offers could time out during the run.
- **Data:** the demo clients from [`../data/waitlist.csv`](../data/waitlist.csv). The names and `(555)` numbers are made up.

Texts and Square bookings are simulated, as the page says.

| File | Slot | What it shows |
| --- | --- | --- |
| [`01-openings-active-offer.png`](01-openings-active-offer.png) | Maya · Cut & style, Fri Oct 9, 4:00 PM | **Main page** with an active opening: "Offered to Grace Liu · 0:54 left" and the summary line "1 declined · 1 no reply · 0 left". Also visible: a slot that needs the front desk, and the green "Filled" notice. |
| [`02-slot-detail-mid-run.png`](02-slot-detail-mid-run.png) | Same slot | **Slot detail mid-run.** Priya *Declined*, Daniel *No reply* (his 60 seconds ran out), Grace *Has the offer* with a countdown. Alongside: the timeline of each step and the simulated texts sent to all three. |
| [`03-filled-notice.png`](03-filled-notice.png) | Jordan · Blowout, Fri Oct 9, 9:00 AM | **Main page with a "Filled" notice:** "Sam Okafor took Jordan's 9:00 AM Blowout", with a Dismiss button. It stays on every browser until the front desk dismisses it. |
| [`04-needs-front-desk.png`](04-needs-front-desk.png) | Lena · Color refresh, Thu Oct 8, 10:00 AM | **A slot that needs the front desk.** Rosa, the only match, declined. The page shows the amber "Front desk: this slot needs you" banner, the Unfilled status, the **Mark handled** button, and the front desk's text alert. |
| [`05-crash-test-temporal-history.png`](05-crash-test-temporal-history.png) | Maya · Cut & style, Mon Oct 12, 1:00 PM | **Crash test, Temporal UI timeline.** Priya's 1-minute reply timer runs. The marked gap on the axis is while the Worker was down. After it, `sendOffer` to Daniel and his own timer show the Workflow carried on. |
| [`05b-crash-test-event-history.png`](05b-crash-test-event-history.png) | Same slot | **Crash test, full event history** in the Temporal UI, oldest first (walkthrough below). |
| [`06-crash-test-slot-detail.png`](06-crash-test-slot-detail.png) | Same slot | **Crash test, as the salon sees it.** Priya shows *No reply* and Daniel *Has the offer*. Priya's offer text is missing from "Simulated texts" because the demo outbox lives in Worker memory and was wiped when the Worker was killed. The Workflow's own state was safe in Temporal. |

## The crash test, step by step

1. Opened the slot. The Worker texted Priya and started her 60-second reply timer.
2. Killed the Worker process (`taskkill /T /F`) while Priya held the offer.
3. Waited 75 seconds, past the end of her reply window, with no Worker running.
4. Started a new Worker. It picked the Workflow up where it left off: it recorded Priya's timeout and offered the slot to Daniel.

## Reading the event history (05b)

| Event | Time | What happened |
| --- | --- | --- |
| 11–13 | 7:08:22 PM | `sendOffer` to Priya runs on the first Worker, `23260@Ak-Laptop`. |
| 17 | 7:08:22 PM | Priya's 1-minute timer starts. The Worker is killed about two seconds later. |
| 18 | 7:09:22 PM | **Timer Fired.** Temporal fires the timer on schedule even though no Worker is running. |
| 19–21 | 7:09:22–7:09:32 PM | The task waits for the dead Worker, times out (the red row), and is put back on the shared `juniper-waitlist` queue. |
| 22 | 7:09:52 PM | The new Worker, `3284@Ak-Laptop`, picks the task up. |
| 24–26 | 7:09:54 PM | `sendOffer` to Daniel runs on the new Worker. |
| 30 | 7:09:54 PM | Daniel's timer starts. |

Events 31–32 came after the script had finished and stopped the Worker: Daniel's timer fired and is waiting for a Worker. That's why the Workflow still shows as Running.
