import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  flag,
  integer,
  option,
  requirePositional,
  storyIds,
  text,
} from "./args.js";
import {
  requireAgent,
  requireEpic,
  requireState,
  requireToken,
  writeConfig,
  CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
} from "./config.js";
import { createAgentEvent, parseAgentEvent } from "./comments.js";
import {
  assertNoCycle,
  assertSameEpic,
  classifyStories,
  isReady,
  linkEndpoints,
  owners,
  sortStories,
  stateIndex,
  storyEpicId,
  storyState,
  summarizeStory,
} from "./domain.js";
import {
  argumentError,
  configError,
  conflictError,
} from "./errors.js";

function runId(config) {
  return config.runId ?? randomUUID();
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function textOption(options, name, { required = false, stdin = process.stdin } = {}) {
  const inline = option(options, name);
  const filename = option(options, `${name}-file`);
  if (inline !== undefined && filename !== undefined) {
    throw argumentError(`Use either --${name} or --${name}-file, not both`);
  }
  let value;
  if (inline !== undefined && inline !== true) value = String(inline);
  else if (filename === "-") value = await readStream(stdin);
  else if (filename !== undefined && filename !== true) {
    try {
      value = await readFile(path.resolve(String(filename)), "utf8");
    } catch (error) {
      throw argumentError(`Could not read --${name}-file`, {
        filename,
        reason: error.message,
      });
    }
  }
  if (required && (!value || !value.trim())) {
    throw argumentError(
      `--${name} or --${name}-file is required and must not be empty`,
    );
  }
  return value;
}

async function statesFor(client) {
  const states = await client.listWorkflowStates();
  return { states, index: stateIndex(states) };
}

async function epicStories(client, config) {
  const epicId = requireEpic(config);
  const [stories, stateData] = await Promise.all([
    client.listEpicStories(epicId),
    statesFor(client),
  ]);
  return { epicId, stories, ...stateData };
}

function memberId(whoami) {
  const id = whoami?.member?.id;
  if (!id) throw configError("Shortcut whoami did not return a member ID");
  return id;
}

function assertOwnedBy(story, id, { allowUnowned = false, force = false } = {}) {
  if (force) return;
  const currentOwners = owners(story);
  if (allowUnowned && currentOwners.length === 0) return;
  if (!currentOwners.some((owner) => owner.id === id)) {
    throw conflictError(
      "ownership_conflict",
      `Story ${story.id} is not owned by the authenticated Shortcut member`,
      { owners: currentOwners.map((owner) => ({ id: owner.id, name: owner.name })) },
    );
  }
}

function eventInput(parsed, config, event, requiredField) {
  const value = requiredField ? option(parsed.options, requiredField) : undefined;
  if (requiredField && (value === undefined || value === true || !String(value).trim())) {
    throw argumentError(`--${requiredField} is required`);
  }
  return createAgentEvent({
    event,
    agentId: requireAgent(config),
    runId: runId(config),
    summary: option(parsed.options, "summary"),
    reason: option(parsed.options, "reason"),
    changed: option(parsed.options, "changed"),
    verification: option(parsed.options, "verification"),
    remaining: option(parsed.options, "remaining"),
    evidence: option(parsed.options, "evidence"),
  });
}

function configuredStateTypes(config, index) {
  const result = {};
  for (const [name, id] of Object.entries(config.states)) {
    if (id) result[name] = index.get(Number(id));
  }
  return result;
}

export async function initCommand(parsed, context) {
  const { config, makeClient, cwd = process.cwd() } = context;
  requireToken(config);
  const discoveryClient = makeClient({ workspace: undefined });
  const whoami = await discoveryClient.whoami();
  const workspace = option(parsed.options, "workspace") ?? whoami?.workspace?.slug;
  if (!workspace) throw configError("Shortcut whoami did not return a workspace slug");

  const client = makeClient({ workspace });
  const [states, epic] = await Promise.all([
    client.listWorkflowStates(),
    client.getEpic(requireEpic(config)),
  ]);
  const workflowId = Number(whoami?.default_workflow?.id);
  const workflowStates = states.filter(
    (state) => !workflowId || Number(state.workflow?.id) === workflowId,
  );
  const candidates = workflowStates.length ? workflowStates : states;
  const choose = (type, namePattern) =>
    candidates.find(
      (state) =>
        state.type === type && (!namePattern || namePattern.test(state.name ?? "")),
    ) ?? candidates.find((state) => state.type === type);

  const ready =
    config.states.ready ??
    choose("unstarted")?.id ??
    choose("backlog")?.id;
  const started = config.states.started ?? choose("started")?.id;
  const done = config.states.done ?? choose("done", /done|complete|finish/i)?.id;
  const cancelled =
    config.states.cancelled ?? choose("done", /cancel|won't|wont|abandon/i)?.id ?? done;
  if (!ready || !started || !done) {
    throw configError("Could not discover required ready, started, and done states", {
      states: candidates.map(({ id, name, type }) => ({ id, name, type })),
    });
  }
  const document = {
    workspace,
    epic_id: Number(epic.id),
    ...(config.teamId ? { team_id: config.teamId } : {}),
    states: {
      ready: Number(ready),
      started: Number(started),
      done: Number(done),
      cancelled: Number(cancelled),
    },
  };
  const filename =
    option(parsed.options, "config") ??
    config.filename ??
    path.join(cwd, CONFIG_FILENAME);
  const written = await writeConfig(filename, document);
  const requestedAgent = option(parsed.options, "agent");
  const agentToPersist =
    requestedAgent ??
    (config.agentSource === "project-config" ? config.agentId : undefined);
  let localWritten;
  if (agentToPersist !== undefined) {
    if (agentToPersist === true || !String(agentToPersist).trim()) {
      throw argumentError("--agent must not be empty");
    }
    const localTarget = path.join(path.dirname(written), LOCAL_CONFIG_FILENAME);
    const existingLocal =
      config.localFilename && path.resolve(config.localFilename) === path.resolve(localTarget)
        ? config.localRaw
        : {};
    localWritten = await writeConfig(localTarget, {
      ...existingLocal,
      agent_id: String(agentToPersist),
    });
  }
  return {
    ok: true,
    command: "init",
    config_file: written,
    workspace,
    epic: { id: Number(epic.id), name: epic.name },
    ...(localWritten
      ? { local_config_file: localWritten, agent_id: String(agentToPersist) }
      : {}),
    states: document.states,
  };
}

async function configCommand(_parsed, { config }) {
  return {
    ok: true,
    command: "config",
    config_file: config.filename,
    local_config_file: config.localFilename,
    api_url: config.apiUrl,
    token_configured: Boolean(config.token),
    workspace: config.workspace,
    epic_id: config.epicId,
    team_id: config.teamId,
    agent_id: config.agentId,
    agent_id_source: config.agentSource,
    states: config.states,
  };
}

async function doctorCommand(_parsed, { client, config }) {
  const epicId = requireEpic(config);
  const [whoami, epic, stateData] = await Promise.all([
    client.whoami(),
    client.getEpic(epicId),
    statesFor(client),
  ]);
  const configured = configuredStateTypes(config, stateData.index);
  const warnings = [];
  const expected = {
    ready: new Set(["backlog", "unstarted"]),
    started: new Set(["started"]),
    done: new Set(["done"]),
    cancelled: new Set(["done"]),
  };
  for (const name of ["ready", "started", "done", "cancelled"]) {
    if (!config.states[name]) warnings.push(`${name} state is not configured`);
    else if (!configured[name]) warnings.push(`${name} state ${config.states[name]} was not found`);
    else if (!expected[name].has(configured[name].type)) {
      warnings.push(
        `${name} state ${configured[name].name} has unexpected type ${configured[name].type}`,
      );
    }
  }
  return {
    ok: warnings.length === 0,
    command: "doctor",
    workspace: whoami.workspace,
    member: whoami.member,
    epic: { id: Number(epic.id), name: epic.name },
    agent_id: config.agentId,
    agent_id_source: config.agentSource,
    states: Object.fromEntries(
      Object.entries(configured).map(([name, state]) => [
        name,
        state ? { id: Number(state.id), name: state.name, type: state.type } : null,
      ]),
    ),
    warnings,
  };
}

async function createCommand(parsed, { client, config, stdin }) {
  const epicId = requireEpic(config);
  const title = option(parsed.options, "title") ?? parsed.args[0];
  if (!title || title === true) throw argumentError("--title is required");
  const description = await textOption(parsed.options, "description", {
    required: true,
    stdin,
  });
  const storyType = option(parsed.options, "type", "chore");
  if (!["bug", "chore", "feature"].includes(storyType)) {
    throw argumentError("--type must be bug, chore, or feature");
  }
  const links = [
    ...storyIds(parsed.options, "blocked-by").map((id) => ({
      subject_story_id: id,
      verb: "blocks",
    })),
    ...storyIds(parsed.options, "blocks").map((id) => ({
      object_story_id: id,
      verb: "blocks",
    })),
    ...storyIds(parsed.options, "related-to").map((id) => ({
      object_story_id: id,
      verb: "relates to",
    })),
  ];
  const body = {
    name: String(title),
    description,
    epic_id: epicId,
    workflow_state_id: requireState(config, "ready"),
    story_type: storyType,
    ...(config.teamId ? { team_id: config.teamId } : {}),
    ...(links.length ? { story_links: links } : {}),
  };
  const estimate = option(parsed.options, "estimate");
  if (estimate !== undefined) body.estimate = integer(estimate, "--estimate");
  const story = await client.createStory(body);
  const { index } = await statesFor(client);
  return {
    ok: true,
    command: "create",
    story: summarizeStory(story, index, { includeDescription: true }),
  };
}

async function listCommand(parsed, { client, config }) {
  const { epicId, stories, index } = await epicStories(client, config);
  return {
    ok: true,
    command: "list",
    epic_id: epicId,
    stories: sortStories(stories).map((story) => summarizeStory(story, index)),
  };
}

async function readyCommand(parsed, { client, config }) {
  const { epicId, stories, index } = await epicStories(client, config);
  const includeAssigned = flag(parsed.options, "include-assigned");
  return {
    ok: true,
    command: "ready",
    epic_id: epicId,
    stories: sortStories(
      stories.filter((story) => isReady(story, index, { includeAssigned })),
    ).map((story) => summarizeStory(story, index)),
  };
}

async function blockedCommand(_parsed, { client, config }) {
  const { epicId, stories, index } = await epicStories(client, config);
  const blocked = sortStories(stories.filter((story) => story.blocked === true));
  const blockerIds = new Set(
    blocked.flatMap((story) => summarizeStory(story, index).blocked_by),
  );
  const blockerStories = new Map();
  await Promise.all(
    [...blockerIds].map(async (id) => blockerStories.set(id, await client.getStory(id))),
  );
  return {
    ok: true,
    command: "blocked",
    epic_id: epicId,
    stories: blocked.map((story) => {
      const summary = summarizeStory(story, index);
      return {
        ...summary,
        blockers: summary.blocked_by.map((id) => {
          const blocker = blockerStories.get(id);
          return blocker
            ? summarizeStory(blocker, index)
            : { id, unavailable: true };
        }),
      };
    }),
  };
}

async function showCommand(parsed, { client }) {
  const storyId = integer(requirePositional(parsed, 0, "Story ID"), "Story ID", {
    required: true,
  });
  const [story, stateData, comments] = await Promise.all([
    client.getStory(storyId),
    statesFor(client),
    client.listStoryComments(storyId),
  ]);
  const allComments = flag(parsed.options, "all-comments");
  const selected = allComments ? comments : comments.slice(-10);
  return {
    ok: true,
    command: "show",
    story: summarizeStory(story, stateData.index, { includeDescription: true }),
    comments: selected.map((comment) => ({
      id: Number(comment.id),
      author: comment.author,
      text: comment.text,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      external_id: comment.external_id,
      agent_event: parseAgentEvent(comment.text),
    })),
    comments_returned: selected.length,
    comments_total: comments.length,
  };
}

async function editCommand(parsed, { client, config, stdin }) {
  const storyId = integer(requirePositional(parsed, 0, "Story ID"), "Story ID", {
    required: true,
  });
  const body = {};
  const title = option(parsed.options, "title");
  if (title !== undefined && title !== true) body.name = String(title);
  const description = await textOption(parsed.options, "description", { stdin });
  if (description !== undefined) body.description = description;
  const type = option(parsed.options, "type");
  if (type !== undefined) {
    if (!["bug", "chore", "feature"].includes(type)) {
      throw argumentError("--type must be bug, chore, or feature");
    }
    body.story_type = type;
  }
  if (option(parsed.options, "estimate") !== undefined) {
    body.estimate = integer(option(parsed.options, "estimate"), "--estimate");
  }
  if (flag(parsed.options, "clear-estimate")) body.estimate = null;
  const moveToEpic = option(parsed.options, "move-to-epic");
  if (moveToEpic !== undefined) {
    body.epic_id = integer(moveToEpic, "--move-to-epic", { required: true });
  }
  if (option(parsed.options, "set-team") !== undefined) {
    const requested = text(parsed.options, "set-team") ?? config.teamId;
    if (!requested) {
      throw argumentError("--set-team requires a Team UUID or a configured team");
    }
    body.team_id = requested;
  }
  if (flag(parsed.options, "clear-team")) body.team_id = null;
  if (option(parsed.options, "state") !== undefined) {
    body.workflow_state_id = integer(option(parsed.options, "state"), "--state");
  }
  if (Object.keys(body).length === 0) {
    throw argumentError("edit requires at least one field option");
  }
  const story = await client.updateStory(storyId, body);
  const { index } = await statesFor(client);
  return {
    ok: true,
    command: "edit",
    story: summarizeStory(story, index, { includeDescription: true }),
  };
}

async function startCommand(parsed, { client, config }) {
  const storyId = integer(requirePositional(parsed, 0, "Story ID"), "Story ID", {
    required: true,
  });
  const epicId = requireEpic(config);
  const agentId = requireAgent(config);
  const [story, whoami, stateData] = await Promise.all([
    client.getStory(storyId),
    client.whoami(),
    statesFor(client),
  ]);
  assertSameEpic(story, epicId);
  const state = storyState(story, stateData.index);
  if (story.blocked === true) {
    throw conflictError("story_blocked", `Story ${storyId} is blocked`, {
      blocked_by: summarizeStory(story, stateData.index).blocked_by,
    });
  }
  if (!["backlog", "unstarted"].includes(state.type)) {
    throw conflictError(
      "invalid_story_state",
      `Story ${storyId} is in ${state.name ?? state.type}, not a ready state`,
    );
  }
  if (owners(story).length > 0) {
    throw conflictError("claim_conflict", `Story ${storyId} already has an owner`, {
      owners: owners(story),
    });
  }
  const ownerId = memberId(whoami);
  const startedState = requireState(config, "started");
  await client.updateStory(storyId, {
    owner_ids: [ownerId],
    workflow_state_id: startedState,
  });
  const claim = createAgentEvent({
    event: "claim",
    agentId,
    runId: runId(config),
    extra: { story_id: storyId, owner_id: ownerId },
  });
  const warnings = [];
  let comment;
  try {
    comment = await client.createStoryComment(storyId, claim.comment);
  } catch (error) {
    warnings.push(`Claim succeeded but claim comment failed: ${error.message}`);
  }
  const verified = await client.getStory(storyId);
  if (
    Number(verified.workflow_state?.id ?? verified.workflow_state_id) !==
      Number(startedState) ||
    !owners(verified).some((owner) => owner.id === ownerId)
  ) {
    throw conflictError(
      "claim_conflict",
      `Story ${storyId} claim did not survive verification`,
      { claim_id: claim.eventId },
    );
  }
  return {
    ok: true,
    command: "start",
    claim: claim.metadata,
    claim_comment_id: comment?.id,
    story: summarizeStory(verified, stateData.index),
    warnings,
  };
}

async function lifecycleCommand(parsed, context, event) {
  const { client, config } = context;
  const storyId = integer(requirePositional(parsed, 0, "Story ID"), "Story ID", {
    required: true,
  });
  const epicId = requireEpic(config);
  const [story, whoami, stateData] = await Promise.all([
    client.getStory(storyId),
    client.whoami(),
    statesFor(client),
  ]);
  assertSameEpic(story, epicId);
  const ownerId = memberId(whoami);
  const force = flag(parsed.options, "force");
  assertOwnedBy(story, ownerId, {
    allowUnowned: event === "cancel",
    force,
  });
  if (event === "complete" && !force && storyState(story, stateData.index).type !== "started") {
    throw conflictError(
      "invalid_story_state",
      `Story ${storyId} must be started before it can be completed`,
    );
  }
  const requiredField = event === "cancel" || event === "release" ? "reason" : "summary";
  const agentEvent = eventInput(parsed, config, event, requiredField);
  const comment = await client.createStoryComment(storyId, agentEvent.comment);

  let body;
  if (event === "complete") {
    body = { workflow_state_id: requireState(config, "done") };
  } else if (event === "cancel") {
    body = {
      workflow_state_id: config.states.cancelled ?? requireState(config, "done"),
    };
  } else {
    body = {
      owner_ids: [],
      workflow_state_id: requireState(config, "ready"),
    };
  }
  const updated = await client.updateStory(storyId, body);
  return {
    ok: true,
    command: event,
    event: agentEvent.metadata,
    comment_id: comment?.id,
    story: summarizeStory(updated, stateData.index),
    warnings:
      event === "cancel" && summarizeStory(story, stateData.index).blocks.length
        ? ["Cancellation uses a Done-type state and may unblock downstream Stories"]
        : [],
  };
}

async function handoffCommand(parsed, { client, config }) {
  const storyId = integer(requirePositional(parsed, 0, "Story ID"), "Story ID", {
    required: true,
  });
  const epicId = requireEpic(config);
  const [story, whoami, stateData] = await Promise.all([
    client.getStory(storyId),
    client.whoami(),
    statesFor(client),
  ]);
  assertSameEpic(story, epicId);
  assertOwnedBy(story, memberId(whoami), { force: flag(parsed.options, "force") });
  const handoff = eventInput(parsed, config, "handoff", "summary");
  const comment = await client.createStoryComment(storyId, handoff.comment);
  let updated = story;
  if (flag(parsed.options, "release")) {
    updated = await client.updateStory(storyId, {
      owner_ids: [],
      workflow_state_id: requireState(config, "ready"),
    });
  }
  return {
    ok: true,
    command: "handoff",
    event: handoff.metadata,
    comment_id: comment?.id,
    released: flag(parsed.options, "release"),
    story: summarizeStory(updated, stateData.index),
  };
}

function dependencySpec(parsed, storyId) {
  const entries = [
    ...storyIds(parsed.options, "blocked-by").map((target) => ({
      subjectId: target,
      objectId: storyId,
      verb: "blocks",
      relation: "blocked-by",
    })),
    ...storyIds(parsed.options, "blocks").map((target) => ({
      subjectId: storyId,
      objectId: target,
      verb: "blocks",
      relation: "blocks",
    })),
    ...storyIds(parsed.options, "related-to").map((target) => ({
      subjectId: storyId,
      objectId: target,
      verb: "relates to",
      relation: "related-to",
    })),
  ];
  if (entries.length !== 1) {
    throw argumentError(
      "dep requires exactly one --blocked-by, --blocks, or --related-to Story ID",
    );
  }
  return entries[0];
}

async function dependencyCommand(parsed, { client, config }) {
  const action = requirePositional(parsed, 0, "dep action");
  if (!["add", "remove"].includes(action)) {
    throw argumentError("dep action must be add or remove");
  }
  const storyId = integer(requirePositional(parsed, 1, "Story ID"), "Story ID", {
    required: true,
  });
  const spec = dependencySpec(parsed, storyId);
  const [subject, object] = await Promise.all([
    client.getStory(spec.subjectId),
    client.getStory(spec.objectId),
  ]);
  const subjectEpic = storyEpicId(subject);
  const objectEpic = storyEpicId(object);
  const crossEpic = subjectEpic !== objectEpic;
  if (crossEpic && !flag(parsed.options, "allow-cross-epic")) {
    throw conflictError(
      "cross_epic_dependency",
      "Cross-Epic dependencies require --allow-cross-epic",
      { subject_epic_id: subjectEpic, object_epic_id: objectEpic },
    );
  }
  if (action === "add") {
    const existingLinks = [
      ...(await client.storyLinks(subject)),
      ...(await client.storyLinks(object)),
    ]
      .map(linkEndpoints)
      .filter(
        (link) =>
          link.subjectId === spec.subjectId &&
          link.objectId === spec.objectId &&
          link.verb === spec.verb,
      );
    if (existingLinks.length) {
      return {
        ok: true,
        command: "dep add",
        link: existingLinks[0],
        unchanged: true,
        warnings: crossEpic
          ? ["Cross-Epic graph cycle safety could not be proven"]
          : [],
      };
    }
    if (spec.verb === "blocks" && !crossEpic) {
      const stories = await client.listEpicStories(subjectEpic);
      await Promise.all(
        stories.map(async (story) => {
          const nested = story.story_links;
          if (
            nested?.list_url &&
            Number(nested.total_items) > (nested.entities?.length ?? 0)
          ) {
            story.story_links = { entities: await client.storyLinks(story) };
          }
        }),
      );
      assertNoCycle(stories, spec.subjectId, spec.objectId);
    }
    const link = await client.createStoryLink({
      subject_story_id: spec.subjectId,
      object_story_id: spec.objectId,
      verb: spec.verb,
    });
    return {
      ok: true,
      command: "dep add",
      link: linkEndpoints(link),
      warnings: crossEpic
        ? ["Cross-Epic graph cycle safety could not be proven"]
        : [],
    };
  }

  const links = await client.storyLinks(storyId === spec.subjectId ? subject : object);
  const matching = links
    .map((link) => ({ raw: link, ...linkEndpoints(link) }))
    .filter(
      (link) =>
        link.subjectId === spec.subjectId &&
        link.objectId === spec.objectId &&
        link.verb === spec.verb,
    );
  if (matching.length === 0) {
    throw conflictError("dependency_not_found", "Matching Story relationship was not found", spec);
  }
  await Promise.all(matching.map((link) => client.deleteStoryLink(link.id)));
  return {
    ok: true,
    command: "dep remove",
    removed_link_ids: matching.map((link) => link.id),
  };
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (typeof value === "boolean" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw argumentError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function latestEvent(events, predicate = () => true) {
  let found;
  for (const event of events) {
    if (!predicate(event)) continue;
    if (!found || String(event.timestamp) > String(found.timestamp)) found = event;
  }
  return found;
}

function claimSummary(story, index, comments, { now, staleMinutes }) {
  const events = comments
    .map((comment) => parseAgentEvent(comment.text))
    .filter(Boolean);
  const claim = latestEvent(events, (event) => event.event === "claim");
  const last = latestEvent(events);
  const activityAt = last?.timestamp ?? story.updated_at;
  const parsed = activityAt ? Date.parse(activityAt) : Number.NaN;
  const idleMinutes = Number.isFinite(parsed)
    ? Math.max(0, Math.round((now - parsed) / 60000))
    : undefined;
  return {
    story: summarizeStory(story, index),
    agent_id: claim?.agent_id ?? null,
    run_id: claim?.run_id ?? null,
    claimed_at: claim?.timestamp ?? null,
    last_event: last
      ? {
          event: last.event,
          timestamp: last.timestamp,
          agent_id: last.agent_id,
          run_id: last.run_id,
        }
      : null,
    idle_minutes: idleMinutes ?? null,
    stale: idleMinutes === undefined ? false : idleMinutes >= staleMinutes,
    unattributed: !claim,
  };
}

async function claimsCommand(parsed, { client, config }) {
  const { epicId, stories, index } = await epicStories(client, config);
  const staleOption = option(parsed.options, "stale-minutes");
  const staleMinutes =
    staleOption === undefined
      ? 60
      : nonNegativeInteger(staleOption, "--stale-minutes");
  const heldBy = flag(parsed.options, "mine")
    ? requireAgent(config)
    : text(parsed.options, "held-by");
  const onlyStale = flag(parsed.options, "stale");

  const inFlight = sortStories(stories).filter((story) => {
    const state = storyState(story, index);
    if (state.type === "done" || story.archived) return false;
    return owners(story).length > 0 || state.type === "started";
  });

  const now = Date.now();
  const claims = await Promise.all(
    inFlight.map(async (story) =>
      claimSummary(story, index, await client.listStoryComments(story.id), {
        now,
        staleMinutes,
      }),
    ),
  );

  return {
    ok: true,
    command: "claims",
    epic_id: epicId,
    stale_minutes: staleMinutes,
    generated_at: new Date(now).toISOString(),
    claims: claims
      .filter((claim) => (heldBy ? claim.agent_id === heldBy : true))
      .filter((claim) => (onlyStale ? claim.stale : true)),
  };
}

async function contextCommand(_parsed, { client, config }) {
  const { epicId, stories, index } = await epicStories(client, config);
  const epic = await client.getEpic(epicId);
  const groups = classifyStories(stories, index);
  const summarize = (items) => items.map((story) => summarizeStory(story, index));
  return {
    ok: true,
    command: "context",
    generated_at: new Date().toISOString(),
    epic: {
      id: Number(epic.id),
      name: epic.name,
      description: epic.description,
      app_url: epic.app_url,
    },
    counts: Object.fromEntries(
      Object.entries(groups).map(([name, items]) => [name, items.length]),
    ),
    ready: summarize(groups.ready),
    active: summarize(groups.active),
    blocked: summarize(groups.blocked),
    other: summarize(groups.other),
    recently_done: summarize(groups.done.slice(-10)),
  };
}

export async function executeCommand(parsed, context) {
  const command = parsed.command;
  if (command === "init") return initCommand(parsed, context);
  if (command === "config") return configCommand(parsed, context);
  if (command === "doctor") return doctorCommand(parsed, context);
  if (command === "create") return createCommand(parsed, context);
  if (command === "list") return listCommand(parsed, context);
  if (command === "ready") return readyCommand(parsed, context);
  if (command === "blocked") return blockedCommand(parsed, context);
  if (command === "show") return showCommand(parsed, context);
  if (command === "edit") return editCommand(parsed, context);
  if (command === "start") return startCommand(parsed, context);
  if (["complete", "cancel", "release"].includes(command)) {
    return lifecycleCommand(parsed, context, command);
  }
  if (command === "handoff") return handoffCommand(parsed, context);
  if (command === "dep") return dependencyCommand(parsed, context);
  if (command === "claims") return claimsCommand(parsed, context);
  if (command === "context") return contextCommand(parsed, context);
  throw argumentError(`Unknown command: ${command ?? "(none)"}`);
}
