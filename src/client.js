import { AppError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const STORY_LIST_FIELDS = [
  "id",
  "name",
  "app_url",
  "epic",
  "workflow_state",
  "owners",
  "position",
  "blocked",
  "blocker",
  "archived",
  "story_type",
  "story_links",
  "updated_at",
].join(",");

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function unwrapEntity(payload) {
  if (payload && typeof payload === "object" && "entity" in payload) {
    return payload.entity;
  }
  return payload;
}

export function unwrapEntities(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.entities)) return payload.entities;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function apiError(status, payload, method, url) {
  const message =
    payload?.message ??
    payload?.error ??
    payload?.errors?.[0]?.message ??
    `Shortcut API returned HTTP ${status}`;
  let exitCode = 6;
  let code = "shortcut_api_error";
  if (status === 401 || status === 403) {
    exitCode = 5;
    code = status === 401 ? "shortcut_authentication_error" : "shortcut_authorization_error";
  } else if (status === 404) {
    code = "shortcut_not_found";
  } else if (status === 409 || status === 422) {
    exitCode = 4;
    code = "shortcut_conflict";
  }
  return new AppError(code, String(message), {
    exitCode,
    details: { status, method, url, response: payload },
  });
}

export class ShortcutClient {
  constructor({
    token,
    workspace,
    baseUrl = "https://api.app.shortcut.com",
    fetchImpl = globalThis.fetch,
    sleeper = sleep,
    maxRetries = 2,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  }) {
    this.token = token;
    this.workspace = workspace;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.sleep = sleeper;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
  }

  workspacePath(pathname) {
    if (!this.workspace) {
      throw new AppError("invalid_configuration", "Shortcut workspace is required", {
        exitCode: 3,
      });
    }
    return `/api/v4/${encodeURIComponent(this.workspace)}${pathname}`;
  }

  url(pathname, query = {}) {
    const url = /^https?:\/\//.test(pathname)
      ? new URL(pathname)
      : new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async request(method, pathname, { query, body } = {}) {
    const url = this.url(pathname, query);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: this.signal
            ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (method === "GET" && attempt < this.maxRetries) {
          await this.sleep(100 * 2 ** attempt);
          continue;
        }
        throw new AppError(
          method === "GET" ? "shortcut_network_error" : "ambiguous_mutation",
          `Shortcut request failed: ${error.message}`,
          {
            exitCode: 6,
            details: { method, url: url.toString() },
            cause: error,
          },
        );
      }

      if (response.status === 429 && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1000, 10_000)
          : 250 * 2 ** attempt;
        await this.sleep(delay);
        continue;
      }
      if (
        method === "GET" &&
        response.status >= 500 &&
        attempt < this.maxRetries
      ) {
        await this.sleep(100 * 2 ** attempt);
        continue;
      }

      const text = response.status === 204 ? "" : await response.text();
      let payload;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }
      if (!response.ok) {
        throw apiError(response.status, payload, method, url.toString());
      }
      return payload;
    }
  }

  async listAll(pathname, query = {}) {
    const entities = [];
    let next = this.url(pathname, { limit: 100, ...query }).toString();
    while (next) {
      const payload = await this.request("GET", next);
      entities.push(...unwrapEntities(payload));
      next = payload?.next_page_url
        ? this.url(payload.next_page_url).toString()
        : undefined;
    }
    return entities;
  }

  async whoami() {
    return unwrapEntity(await this.request("GET", "/api/v4/whoami"));
  }

  async listWorkflowStates() {
    return this.listAll(this.workspacePath("/workflow-states"));
  }

  async getEpic(id) {
    return unwrapEntity(
      await this.request("GET", this.workspacePath(`/epics/${id}`)),
    );
  }

  async getTeam(id) {
    return unwrapEntity(
      await this.request("GET", this.workspacePath(`/teams/${id}`)),
    );
  }

  async listEpicStories(epicId, { fields } = {}) {
    return this.listAll(this.workspacePath(`/epics/${epicId}/stories`), {
      fields: fields ?? STORY_LIST_FIELDS,
      order_by: "position",
      order_dir: "asc",
    });
  }

  async getStory(id, { fields } = {}) {
    return unwrapEntity(
      await this.request("GET", this.workspacePath(`/stories/${id}`), {
        query: { fields },
      }),
    );
  }

  async createStory(body) {
    return unwrapEntity(
      await this.request("POST", this.workspacePath("/stories"), { body }),
    );
  }

  async updateStory(id, body) {
    return unwrapEntity(
      await this.request("PATCH", this.workspacePath(`/stories/${id}`), {
        body,
      }),
    );
  }

  async listStoryComments(id) {
    return this.listAll(this.workspacePath(`/stories/${id}/comments`), {
      order_by: "position",
      order_dir: "asc",
    });
  }

  async createStoryComment(id, body) {
    return unwrapEntity(
      await this.request(
        "POST",
        this.workspacePath(`/stories/${id}/comments`),
        { body },
      ),
    );
  }

  async createStoryLink(body) {
    return unwrapEntity(
      await this.request("POST", this.workspacePath("/story-links"), { body }),
    );
  }

  async deleteStoryLink(id) {
    await this.request("DELETE", this.workspacePath(`/story-links/${id}`));
  }

  async storyLinks(story) {
    const nested = story?.story_links;
    if (nested?.list_url) return this.listAll(nested.list_url);
    return unwrapEntities(nested);
  }
}
