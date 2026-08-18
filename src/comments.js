import { randomUUID } from "node:crypto";

export const EVENT_FORMAT_VERSION = 1;

function lines(label, value) {
  if (value === undefined || value === null || value === "") return [];
  const rendered = Array.isArray(value) ? value.join(", ") : String(value);
  return [`- ${label}: ${rendered}`];
}

export function createAgentEvent({
  event,
  agentId,
  runId,
  summary,
  reason,
  changed,
  verification,
  remaining,
  evidence,
  eventId = randomUUID(),
  timestamp = new Date().toISOString(),
  extra = {},
}) {
  const metadata = {
    version: EVENT_FORMAT_VERSION,
    event,
    event_id: eventId,
    agent_id: agentId,
    run_id: runId,
    timestamp,
    ...extra,
  };
  const heading =
    event === "claim"
      ? "Agent claim"
      : event === "handoff"
        ? "Agent handoff"
        : event === "complete"
          ? "Agent completion"
          : event === "cancel"
            ? "Agent cancellation"
            : event === "release"
              ? "Agent release"
              : "Agent note";

  const body = [
    `## ${heading}`,
    "",
    ...lines("Agent", `\`${agentId}\``),
    ...lines("Run", `\`${runId}\``),
    ...lines("Summary", summary),
    ...lines("Reason", reason),
    ...lines("Changed", changed),
    ...lines("Verification", verification),
    ...lines("Remaining", remaining),
    ...lines("Evidence", evidence),
    "",
    "```shortcut-agent",
    JSON.stringify(metadata),
    "```",
  ].join("\n");

  return {
    eventId,
    timestamp,
    metadata,
    comment: {
      external_id: `shortcut-agent:${event}:${eventId}`.slice(0, 128),
      text: body,
    },
  };
}

export function parseAgentEvent(text) {
  if (typeof text !== "string") return undefined;
  const match = text.match(/```shortcut-agent\s*\n([^\n]+)\n```/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed?.version === EVENT_FORMAT_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}
