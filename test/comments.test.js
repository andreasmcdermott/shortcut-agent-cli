import test from "node:test";
import assert from "node:assert/strict";
import { createAgentEvent, parseAgentEvent } from "../src/comments.js";

test("agent lifecycle comments are readable and round trip metadata", () => {
  const event = createAgentEvent({
    event: "handoff",
    agentId: "worker-1",
    runId: "run-42",
    summary: "Parser is complete",
    eventId: "event-1",
    timestamp: "2026-08-18T00:00:00.000Z",
  });
  assert.match(event.comment.text, /Agent handoff/);
  assert.match(event.comment.text, /Parser is complete/);
  assert.deepEqual(parseAgentEvent(event.comment.text), {
    version: 1,
    event: "handoff",
    event_id: "event-1",
    agent_id: "worker-1",
    run_id: "run-42",
    timestamp: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(event.comment.external_id, "shortcut-agent:handoff:event-1");
});
