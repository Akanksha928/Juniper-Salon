# Temporal post-assessment starter

This repository provides a working local Temporal environment, API, Worker, and browser interface. The included neutral demo is intentionally unrelated to the customer’s final process. Use what you learn in the customer conversation to replace it.

## Important: create a new public repository—do not fork

Your submission must be in a brand-new **public** GitHub repository. **Do not use GitHub’s Fork button.** Forks connect submissions through GitHub’s fork network and can make other participants’ work easier to locate.

Do not add `john-b-yang` or `vishakhpk` as collaborators. Because the repository is public, the assessment team can review it without write access.

Before the timed assessment:

1. Create a new **public** repository in your assigned GitHub organization. Do not initialize it with a README.
2. Clone the starter:

   ```bash
   git clone <STARTER_REPOSITORY_URL> temporal-assessment
   cd temporal-assessment
   ```

3. Point the clone at your new repository:

   ```bash
   git remote remove origin
   git branch -M main
   git remote add origin git@github.com:<YOUR_ORGANIZATION>/<YOUR_REPOSITORY>.git
   git push -u origin main
   ```

4. Confirm that GitHub displays the **Public** label and does not say “forked from” another repository.

If you accidentally create a fork, do not push assessment work to it. Create a new public repository, change your local `origin`, and ask the course team to remove the fork. Do not search for or view other participants’ assessment repositories.

## Verify setup before the timed assessment

Requirements: Node.js 20 or newer and Docker Desktop.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>, run the demo, and confirm that it completes. You can inspect it in the Temporal Web UI at <http://localhost:8233>. Setup time does not count toward the assessment.

Other commands:

```bash
npm test          # Run the starter Workflow test without Docker
npm run typecheck # Check TypeScript
npm run stop      # Stop the local Temporal service
```

## Demo waitlist

The waitlist lives in [`data/waitlist.csv`](data/waitlist.csv), one row per client. In production this would be the salon's Google Sheet. Open it in Excel, Google Sheets, or a text editor. The app re-reads it on every cancellation, so edits apply to the next one without a restart. The page's **Waitlist** section shows what's in the file.

| Column | Example | Notes |
| --- | --- | --- |
| `name` | Priya Shah | |
| `phone` | (555) 010-2231 | Demo numbers only |
| `service` | Cut & style | Must match a service in the form exactly |
| `availability` | `Mon-Fri 09:00-17:00` | Days as a range (`Mon-Fri`) or list (`Tue,Thu`), then a 24-hour time range. Separate several windows with `;`, e.g. `Sat,Sun 10:00-18:00; Mon 17:00-21:00` |
| `preferred_stylist` | Maya | Leave blank for any stylist |
| `joined` | 2026-08-14 | Earliest joiners are texted first. `8/14/2026` also works |

## Repository map

- `data/waitlist.csv` — demo waitlist (see above)
- `src/workflows.ts` — durable Workflow logic and message handlers
- `src/worker.ts` — Worker and Task Queue configuration
- `src/api.ts` — browser-facing API and Temporal Client
- `src/types.ts` — shared data types
- `public/` — customer-facing interface
- `tests/` — Workflow test example

You may change any application file. Do not edit generated files in `node_modules`.

## Documentation

- [TypeScript developer guide](https://docs.temporal.io/develop/typescript)
- [Workflows](https://docs.temporal.io/workflows)
- [Activities](https://docs.temporal.io/activities)
- [Signals, Queries, and Updates](https://docs.temporal.io/encyclopedia/workflow-message-passing)
