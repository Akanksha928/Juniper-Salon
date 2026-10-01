const phase = document.querySelector("#phase");
const message = document.querySelector("#message");
const start = document.querySelector("#start");
const continueButton = document.querySelector("#continue");
const requestIdText = document.querySelector("#request-id");
let requestId;
let pollTimer;

async function refresh() {
  if (!requestId) return;
  const response = await fetch(`/api/demo/${requestId}`);
  const status = await response.json();
  if (!response.ok) {
    phase.textContent = "Waiting for Worker";
    message.textContent = "Temporal has the request and will continue when a Worker is available.";
    return;
  }
  phase.textContent = status.phase;
  message.textContent = status.message;
  continueButton.hidden = status.phase !== "waiting";
  if (status.phase === "complete") clearInterval(pollTimer);
}

start.addEventListener("click", async () => {
  start.disabled = true;
  const response = await fetch("/api/demo", { method: "POST" });
  const body = await response.json();
  requestId = body.requestId;
  requestIdText.textContent = `Workflow ID: ${requestId}`;
  start.hidden = true;
  pollTimer = setInterval(() => refresh().catch(console.error), 500);
  await refresh();
});

continueButton.addEventListener("click", async () => {
  continueButton.disabled = true;
  await fetch(`/api/demo/${requestId}/continue`, { method: "POST" });
  await refresh();
});

