import { conflictError } from "./errors.js";

export function nestedEntities(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.entities)) return value.entities;
  return [];
}

export function stateIndex(states) {
  return new Map(states.map((state) => [Number(state.id), state]));
}

export function storyState(story, statesById) {
  const id = Number(story.workflow_state?.id ?? story.workflow_state_id);
  return statesById.get(id) ?? story.workflow_state ?? { id };
}

export function storyEpicId(story) {
  const value = story.epic?.id ?? story.epic_id;
  return value === null || value === undefined ? undefined : Number(value);
}

export function owners(story) {
  return nestedEntities(story.owners);
}

export function storyLinks(story) {
  return nestedEntities(story.story_links);
}

export function linkEndpoints(link) {
  return {
    id: Number(link.id),
    subjectId: Number(link.subject?.id ?? link.subject_story_id ?? link.subject_id),
    objectId: Number(link.object?.id ?? link.object_story_id ?? link.object_id),
    verb: link.verb,
  };
}

export function isReady(story, statesById, { includeAssigned = false } = {}) {
  const state = storyState(story, statesById);
  return (
    !story.archived &&
    (state.type === "backlog" || state.type === "unstarted") &&
    story.blocked !== true &&
    (includeAssigned || owners(story).length === 0)
  );
}

export function summarizeStory(story, statesById, { includeDescription = false } = {}) {
  const state = storyState(story, statesById);
  const links = storyLinks(story).map(linkEndpoints);
  const summary = {
    id: Number(story.id),
    title: story.name,
    app_url: story.app_url,
    epic_id: storyEpicId(story),
    state: {
      id: Number(state.id),
      name: state.name,
      type: state.type,
    },
    story_type: story.story_type,
    archived: Boolean(story.archived),
    blocked: Boolean(story.blocked),
    blocker: Boolean(story.blocker),
    owners: owners(story).map((owner) => ({
      id: owner.id,
      name: owner.name,
    })),
    position: story.position,
    blocked_by: links
      .filter((link) => link.verb === "blocks" && link.objectId === Number(story.id))
      .map((link) => link.subjectId),
    blocks: links
      .filter((link) => link.verb === "blocks" && link.subjectId === Number(story.id))
      .map((link) => link.objectId),
    duplicates: links
      .filter(
        (link) => link.verb === "duplicates" && link.subjectId === Number(story.id),
      )
      .map((link) => link.objectId),
    duplicated_by: links
      .filter(
        (link) => link.verb === "duplicates" && link.objectId === Number(story.id),
      )
      .map((link) => link.subjectId),
    related_to: links
      .filter((link) => link.verb === "relates to")
      .map((link) =>
        link.subjectId === Number(story.id) ? link.objectId : link.subjectId,
      ),
    updated_at: story.updated_at,
  };
  if (includeDescription) summary.description = story.description ?? "";
  return summary;
}

export function sortStories(stories) {
  return [...stories].sort((left, right) => {
    const leftPosition = Number.isFinite(Number(left.position))
      ? Number(left.position)
      : Number.MAX_SAFE_INTEGER;
    const rightPosition = Number.isFinite(Number(right.position))
      ? Number(right.position)
      : Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || Number(left.id) - Number(right.id);
  });
}

export function classifyStories(stories, statesById, options = {}) {
  const result = { ready: [], active: [], blocked: [], done: [], other: [] };
  for (const story of sortStories(stories)) {
    const state = storyState(story, statesById);
    if (state.type === "done") result.done.push(story);
    else if (story.blocked === true) result.blocked.push(story);
    else if (isReady(story, statesById, options)) result.ready.push(story);
    else if (state.type === "started") result.active.push(story);
    else result.other.push(story);
  }
  return result;
}

export function assertSameEpic(story, epicId) {
  const actual = storyEpicId(story);
  if (actual !== Number(epicId)) {
    throw conflictError(
      "story_outside_epic",
      `Story ${story.id} does not belong to Epic ${epicId}`,
      { story_id: Number(story.id), expected_epic_id: Number(epicId), actual_epic_id: actual },
    );
  }
}

export function assertNoCycle(stories, subjectId, objectId) {
  if (Number(subjectId) === Number(objectId)) {
    throw conflictError("dependency_cycle", "A Story cannot block itself");
  }
  const adjacency = new Map();
  for (const story of stories) {
    for (const link of storyLinks(story).map(linkEndpoints)) {
      if (link.verb !== "blocks") continue;
      if (!adjacency.has(link.subjectId)) adjacency.set(link.subjectId, new Set());
      adjacency.get(link.subjectId).add(link.objectId);
    }
  }
  if (!adjacency.has(Number(subjectId))) adjacency.set(Number(subjectId), new Set());
  adjacency.get(Number(subjectId)).add(Number(objectId));

  const target = Number(subjectId);
  const stack = [Number(objectId)];
  const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === target) {
      throw conflictError(
        "dependency_cycle",
        `Adding ${subjectId} blocks ${objectId} would create a dependency cycle`,
        { subject_story_id: Number(subjectId), object_story_id: Number(objectId) },
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
}
