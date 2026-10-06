import type { OutboxMessage } from "./types";

// Simulated SMS gateway. Lives in the Worker process only, so it resets when
// the Worker restarts — unlike Workflow state, which Temporal keeps durably.
const messages: OutboxMessage[] = [];

export function recordMessage(message: Omit<OutboxMessage, "sentAt">): OutboxMessage {
  // An Activity retried after a crash reuses the same id, so the client is
  // not texted twice.
  const existing = messages.find((m) => m.id === message.id);
  if (existing) return existing;
  const sent = { ...message, sentAt: new Date().toISOString() };
  messages.push(sent);
  console.log(`[sms] to ${sent.toName} (${sent.to}): ${sent.body}`);
  return sent;
}

export function readOutbox(workflowId?: string): OutboxMessage[] {
  return workflowId ? messages.filter((m) => m.workflowId === workflowId) : [...messages];
}
