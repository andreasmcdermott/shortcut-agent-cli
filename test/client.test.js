import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { ShortcutClient } from "../src/client.js";

async function server(handler) {
  const instance = http.createServer(handler);
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return {
    instance,
    url: `http://127.0.0.1:${instance.address().port}`,
  };
}

test("unwraps v4 envelopes and follows cursor pagination", async (t) => {
  const requests = [];
  const mock = await server((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (!request.url.includes("cursor=two")) {
      response.end(
        JSON.stringify({
          entities: [{ id: 1 }],
          next_page_url: "/api/v4/acme/workflow-states?cursor=two",
        }),
      );
    } else {
      response.end(JSON.stringify({ entities: [{ id: 2 }] }));
    }
  });
  t.after(() => mock.instance.close());
  const client = new ShortcutClient({
    token: "token",
    workspace: "acme",
    baseUrl: mock.url,
  });
  assert.deepEqual(await client.listWorkflowStates(), [{ id: 1 }, { id: 2 }]);
  assert.match(requests[0], /limit=100/);
  assert.match(requests[1], /cursor=two/);
});

test("Epic Story lists request the compact agent field set", async (t) => {
  let requestUrl;
  const mock = await server((request, response) => {
    requestUrl = request.url;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ entities: [] }));
  });
  t.after(() => mock.instance.close());
  const client = new ShortcutClient({
    token: "token",
    workspace: "acme",
    baseUrl: mock.url,
  });
  await client.listEpicStories(99);
  const fields = new URL(requestUrl, mock.url).searchParams.get("fields");
  assert.match(fields, /story_links/);
  assert.doesNotMatch(fields, /description/);
});

test("retries a rate-limited request", async (t) => {
  let attempts = 0;
  const mock = await server((_request, response) => {
    attempts += 1;
    response.setHeader("content-type", "application/json");
    if (attempts === 1) {
      response.statusCode = 429;
      response.setHeader("retry-after", "0");
      response.end(JSON.stringify({ message: "slow down" }));
    } else {
      response.end(JSON.stringify({ entity: { id: "me" } }));
    }
  });
  t.after(() => mock.instance.close());
  const client = new ShortcutClient({
    token: "token",
    workspace: "acme",
    baseUrl: mock.url,
    sleeper: async () => {},
  });
  assert.deepEqual(await client.whoami(), { id: "me" });
  assert.equal(attempts, 2);
});
