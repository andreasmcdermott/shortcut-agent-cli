import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoCycle,
  classifyStories,
  isReady,
  stateIndex,
  summarizeStory,
} from "../src/domain.js";

const states = stateIndex([
  { id: 1, name: "Ready", type: "unstarted" },
  { id: 2, name: "Doing", type: "started" },
  { id: 3, name: "Done", type: "done" },
]);

function story(id, stateId, overrides = {}) {
  return {
    id,
    name: `Story ${id}`,
    epic: { id: 99 },
    workflow_state: { id: stateId },
    owners: { entities: [] },
    story_links: { entities: [] },
    position: id,
    ...overrides,
  };
}

test("ready requires an unstarted, unblocked, unowned Story", () => {
  assert.equal(isReady(story(1, 1), states), true);
  assert.equal(isReady(story(1, 1, { blocked: true }), states), false);
  assert.equal(
    isReady(story(1, 1, { owners: { entities: [{ id: "member" }] } }), states),
    false,
  );
  assert.equal(isReady(story(1, 2), states), false);
});

test("normalizes dependency direction", () => {
  const value = story(2, 1, {
    story_links: {
      entities: [
        { id: 10, subject: { id: 1 }, object: { id: 2 }, verb: "blocks" },
        { id: 11, subject: { id: 2 }, object: { id: 3 }, verb: "blocks" },
      ],
    },
  });
  const summary = summarizeStory(value, states);
  assert.deepEqual(summary.blocked_by, [1]);
  assert.deepEqual(summary.blocks, [3]);
});

test("classifies blocked before otherwise ready", () => {
  const groups = classifyStories(
    [story(1, 1), story(2, 2), story(3, 3), story(4, 1, { blocked: true })],
    states,
  );
  assert.deepEqual(groups.ready.map(({ id }) => id), [1]);
  assert.deepEqual(groups.active.map(({ id }) => id), [2]);
  assert.deepEqual(groups.done.map(({ id }) => id), [3]);
  assert.deepEqual(groups.blocked.map(({ id }) => id), [4]);
});

test("rejects a dependency edge that closes a cycle", () => {
  const stories = [
    story(1, 1, {
      story_links: {
        entities: [
          { id: 10, subject: { id: 1 }, object: { id: 2 }, verb: "blocks" },
        ],
      },
    }),
    story(2, 1, {
      story_links: {
        entities: [
          { id: 11, subject: { id: 2 }, object: { id: 3 }, verb: "blocks" },
        ],
      },
    }),
    story(3, 1),
  ];
  assert.throws(() => assertNoCycle(stories, 3, 1), {
    code: "dependency_cycle",
  });
  assert.doesNotThrow(() => assertNoCycle(stories, 1, 3));
});
