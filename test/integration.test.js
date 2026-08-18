import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/main.js";

function capture() {
  let text = "";
  return { write: (value) => (text += value), value: () => text };
}

function fullState(id) {
  return {
    id,
    name: id === 1 ? "Ready" : id === 2 ? "Doing" : "Done",
    type: id === 1 ? "unstarted" : id === 2 ? "started" : "done",
  };
}

function makeStory(id, stateId = 1, overrides = {}) {
  return {
    id,
    name: `Story ${id}`,
    description: "Enough context",
    epic: { id: 99 },
    workflow_state: fullState(stateId),
    owners: { entities: [] },
    story_links: { entities: [] },
    position: id,
    blocked: false,
    archived: false,
    story_type: "chore",
    ...overrides,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

async function mockShortcut() {
  const stories = new Map([
    [1, makeStory(1)],
    [2, makeStory(2, 1, { blocked: true })],
    [3, makeStory(3, 3)],
  ]);
  const comments = new Map();
  const requests = [];
  let nextStoryId = 10;
  const instance = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://mock");
    const body = await readBody(request);
    requests.push({ method: request.method, path: url.pathname, body });
    response.setHeader("content-type", "application/json");
    const send = (value, status = 200) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };

    if (url.pathname === "/api/v4/whoami") {
      return send({
        entity: {
          workspace: { slug: "acme" },
          member: { id: "member-1", name: "Test Member" },
          default_workflow: { id: 50 },
        },
      });
    }
    if (url.pathname === "/api/v4/acme/workflow-states") {
      return send({
        entities: [
          { ...fullState(1), workflow: { id: 50 } },
          { ...fullState(2), workflow: { id: 50 } },
          { ...fullState(3), workflow: { id: 50 } },
        ],
      });
    }
    if (url.pathname === "/api/v4/acme/epics/99") {
      return send({ entity: { id: 99, name: "Agent Project", description: "Goal" } });
    }
    if (url.pathname === "/api/v4/acme/epics/99/stories") {
      return send({ entities: [...stories.values()] });
    }
    if (url.pathname === "/api/v4/acme/stories" && request.method === "POST") {
      const created = makeStory(nextStoryId, body.workflow_state_id, {
        name: body.name,
        description: body.description,
        story_links: { entities: body.story_links ?? [] },
      });
      nextStoryId += 1;
      stories.set(created.id, created);
      return send({ entity: created }, 201);
    }
    if (url.pathname === "/api/v4/acme/story-links" && request.method === "POST") {
      const link = {
        id: 100 + requests.length,
        subject: { id: body.subject_story_id },
        object: { id: body.object_story_id },
        verb: body.verb,
      };
      for (const id of [body.subject_story_id, body.object_story_id]) {
        const story = stories.get(id);
        story.story_links.entities.push(link);
      }
      return send({ entity: link }, 201);
    }
    const storyMatch = url.pathname.match(/^\/api\/v4\/acme\/stories\/(\d+)$/);
    if (storyMatch) {
      const id = Number(storyMatch[1]);
      const story = stories.get(id);
      if (request.method === "GET") return send({ entity: story });
      if (request.method === "PATCH") {
        if (body.workflow_state_id) story.workflow_state = fullState(body.workflow_state_id);
        if (body.owner_ids) {
          story.owners = {
            entities: body.owner_ids.map((ownerId) => ({ id: ownerId, name: "Test Member" })),
          };
        }
        Object.assign(story, body);
        return send({ entity: story });
      }
    }
    const commentsMatch = url.pathname.match(
      /^\/api\/v4\/acme\/stories\/(\d+)\/comments$/,
    );
    if (commentsMatch) {
      const id = Number(commentsMatch[1]);
      if (request.method === "GET") return send({ entities: comments.get(id) ?? [] });
      const comment = { id: (comments.get(id)?.length ?? 0) + 1, ...body };
      comments.set(id, [...(comments.get(id) ?? []), comment]);
      return send({ entity: comment }, 201);
    }
    return send({ message: `Unhandled ${request.method} ${url.pathname}` }, 404);
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return {
    instance,
    baseUrl: `http://127.0.0.1:${instance.address().port}`,
    stories,
    comments,
    requests,
  };
}

async function fixture(t) {
  const mock = await mockShortcut();
  t.after(() => mock.instance.close());
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-test-"));
  await writeFile(
    path.join(directory, ".shortcut-agent.json"),
    JSON.stringify({
      workspace: "acme",
      epic_id: 99,
      agent_id: "worker-1",
      states: { ready: 1, started: 2, done: 3, cancelled: 3 },
    }),
  );
  return { mock, directory, env: { SHORTCUT_API_TOKEN: "token", SHORTCUT_API_URL: mock.baseUrl } };
}

async function invoke(args, setup) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await run(args, {
    env: setup.env,
    cwd: setup.directory,
    stdout,
    stderr,
  });
  return {
    exitCode,
    stdout: stdout.value(),
    stderr: stderr.value(),
    json: stdout.value() ? JSON.parse(stdout.value()) : undefined,
  };
}

test("ready is Epic-scoped and excludes blocked and completed Stories", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(["ready"], setup);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.json.stories.map(({ id }) => id), [1]);
});

test("create sends natural dependency directions", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(
    [
      "create",
      "--title",
      "New work",
      "--description",
      "Detailed context",
      "--blocked-by",
      "1",
      "--blocks",
      "3",
    ],
    setup,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const request = setup.mock.requests.find(
    ({ method, path: pathname }) =>
      method === "POST" && pathname === "/api/v4/acme/stories",
  );
  assert.deepEqual(request.body.story_links, [
    { subject_story_id: 1, verb: "blocks" },
    { object_story_id: 3, verb: "blocks" },
  ]);
});

test("start assigns member, moves state, verifies, and records claim comment", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(["start", "1"], setup);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.json.story.state.type, "started");
  assert.equal(result.json.claim.agent_id, "worker-1");
  assert.equal(setup.mock.stories.get(1).owners.entities[0].id, "member-1");
  assert.match(setup.mock.comments.get(1)[0].text, /```shortcut-agent/);
});

test("start refuses blocked work with a stable conflict exit code", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(["start", "2"], setup);
  assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.stderr).error.code, "story_blocked");
});

test("complete writes evidence before moving to Done", async (t) => {
  const setup = await fixture(t);
  await invoke(["start", "1"], setup);
  const result = await invoke(
    ["complete", "1", "--summary", "Finished", "--verification", "npm test"],
    setup,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.json.story.state.type, "done");
  assert.match(setup.mock.comments.get(1).at(-1).text, /Agent completion/);
  assert.match(setup.mock.comments.get(1).at(-1).text, /npm test/);
});

test("init discovers workspace and semantic workflow states", async (t) => {
  const mock = await mockShortcut();
  t.after(() => mock.instance.close());
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-init-test-"));
  const result = await invoke(
    ["init", "--epic", "99"],
    {
      directory,
      env: { SHORTCUT_API_TOKEN: "token", SHORTCUT_API_URL: mock.baseUrl },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const config = JSON.parse(
    await readFile(path.join(directory, ".shortcut-agent.json"), "utf8"),
  );
  assert.equal(config.workspace, "acme");
  assert.equal(Object.hasOwn(config, "agent_id"), false);
  assert.deepEqual(config.states, { ready: 1, started: 2, done: 3, cancelled: 3 });
  await assert.rejects(
    readFile(path.join(directory, ".shortcut-agent.local.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("init stores an explicitly requested agent only in ignored local config", async (t) => {
  const mock = await mockShortcut();
  t.after(() => mock.instance.close());
  const directory = await mkdtemp(path.join(tmpdir(), "shortcut-agent-local-init-test-"));
  const result = await invoke(
    ["init", "--epic", "99", "--agent", "worker-7"],
    {
      directory,
      env: { SHORTCUT_API_TOKEN: "token", SHORTCUT_API_URL: mock.baseUrl },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const shared = JSON.parse(
    await readFile(path.join(directory, ".shortcut-agent.json"), "utf8"),
  );
  const local = JSON.parse(
    await readFile(path.join(directory, ".shortcut-agent.local.json"), "utf8"),
  );
  assert.equal(Object.hasOwn(shared, "agent_id"), false);
  assert.equal(local.agent_id, "worker-7");
});

test("dependency addition is directional and idempotent", async (t) => {
  const setup = await fixture(t);
  const first = await invoke(["dep", "add", "1", "--blocks", "3"], setup);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual(first.json.link, {
    id: first.json.link.id,
    subjectId: 1,
    objectId: 3,
    verb: "blocks",
  });
  const second = await invoke(["dep", "add", "1", "--blocks", "3"], setup);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(second.json.unchanged, true);
  const creates = setup.mock.requests.filter(
    ({ method, path: pathname }) =>
      method === "POST" && pathname === "/api/v4/acme/story-links",
  );
  assert.equal(creates.length, 1);
});

test("a bare --epic is rejected instead of silently targeting Epic 1", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(["list", "--epic"], setup);
  assert.equal(result.exitCode, 2);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, "invalid_arguments");
  assert.match(error.message, /requires a value/);
  assert.equal(
    setup.mock.requests.some((request) => request.path.includes("/epics/1/")),
    false,
    "must not have queried Epic 1",
  );
});

test("edit does not move a Story when --epic is used as a scope override", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(
    ["edit", "1", "--epic", "99", "--title", "Renamed"],
    setup,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const patch = setup.mock.requests.find(
    (request) => request.method === "PATCH" && request.path.endsWith("/stories/1"),
  );
  assert.equal(patch.body.name, "Renamed");
  assert.equal("epic_id" in patch.body, false, "scope flag must not mutate the Epic");
});

test("edit moves a Story only through the explicit --move-to-epic flag", async (t) => {
  const setup = await fixture(t);
  const result = await invoke(["edit", "1", "--move-to-epic", "77"], setup);
  assert.equal(result.exitCode, 0, result.stderr);
  const patch = setup.mock.requests.find(
    (request) => request.method === "PATCH" && request.path.endsWith("/stories/1"),
  );
  assert.equal(patch.body.epic_id, 77);
});

test("claims attributes an in-flight Story to the agent that claimed it", async (t) => {
  const setup = await fixture(t);
  await invoke(["start", "1"], setup);
  const result = await invoke(["claims"], setup);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.json.claims.length, 1);
  const claim = result.json.claims[0];
  assert.equal(claim.story.id, 1);
  assert.equal(claim.agent_id, "worker-1");
  assert.equal(claim.unattributed, false);
  assert.equal(claim.stale, false);
  assert.ok(claim.claimed_at);
});

test("claims marks work stale against the configured threshold", async (t) => {
  const setup = await fixture(t);
  await invoke(["start", "1"], setup);
  const fresh = await invoke(["claims", "--stale"], setup);
  assert.deepEqual(fresh.json.claims, []);
  const stale = await invoke(["claims", "--stale", "--stale-minutes", "0"], setup);
  assert.equal(stale.json.claims.length, 1);
  assert.equal(stale.json.claims[0].stale, true);
});

test("claims filters by holder so an agent can recover its own work", async (t) => {
  const setup = await fixture(t);
  await invoke(["start", "1"], setup);
  const mine = await invoke(["claims", "--mine"], setup);
  assert.deepEqual(mine.json.claims.map((claim) => claim.story.id), [1]);
  const others = await invoke(["claims", "--held-by", "worker-9"], setup);
  assert.deepEqual(others.json.claims, []);
});

test("claims surfaces owned Stories that carry no claim comment", async (t) => {
  const setup = await fixture(t);
  setup.mock.stories.get(2).owners = {
    entities: [{ id: "member-1", name: "Test Member" }],
  };
  const result = await invoke(["claims"], setup);
  const claim = result.json.claims.find((entry) => entry.story.id === 2);
  assert.ok(claim, "owned Story must be reported");
  assert.equal(claim.unattributed, true);
  assert.equal(claim.agent_id, null);
});
