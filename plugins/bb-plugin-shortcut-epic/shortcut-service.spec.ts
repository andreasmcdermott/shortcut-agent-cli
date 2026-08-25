import { describe, expect, it } from "vitest";
import { statesForCommand } from "./shortcut-service.js";

const states = {
  ready: 1493,
  started: 1491,
  review: 2199,
  done: 1494,
  cancelled: 500105500,
};

describe("Shortcut command compatibility routing", () => {
  it("aliases a legacy complete destination to Review in review mode", () => {
    expect(statesForCommand("complete", "review", states)).toEqual({
      ...states,
      done: 2199,
    });
  });

  it("preserves Done completion when the project opts in", () => {
    expect(statesForCommand("complete", "done", states)).toBe(states);
  });

  it("does not alter state routing for other commands", () => {
    expect(statesForCommand("cancel", "review", states)).toBe(states);
  });

  it("fails closed when Review completion has no Review state", () => {
    expect(() =>
      statesForCommand("complete", "review", {
        ...states,
        review: undefined,
      }),
    ).toThrow(/review workflow state is not configured/i);
  });
});
