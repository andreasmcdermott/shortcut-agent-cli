export interface ShortcutWorkflowState {
  id: number | string;
  name?: string;
  type?: string;
  workflow?: { id: number | string; name?: string };
}

export interface ShortcutStoryLink {
  id: number | string;
  verb?: string;
  subject?: { id: number | string };
  object?: { id: number | string };
  subject_story_id?: number | string;
  object_story_id?: number | string;
  subject_id?: number | string;
  object_id?: number | string;
}

export interface ShortcutStory {
  id: number | string;
  name?: string;
  app_url?: string;
  description?: string;
  position?: number | string;
  updated_at?: string;
  blocked?: boolean;
  archived?: boolean;
  story_links?:
    | ShortcutStoryLink[]
    | {
        list_url?: string;
        total_items?: number;
        entities?: ShortcutStoryLink[];
      };
  [key: string]: unknown;
}

export interface ShortcutEpic {
  id: number | string;
  name?: string;
  description?: string;
  app_url?: string;
  archived?: boolean;
  completed?: boolean;
  updated_at?: string;
  owners?: {
    entities?: Array<{ id: string; name?: string }>;
  };
  owner_ids?: string[];
  [key: string]: unknown;
}

export interface ShortcutClientOptions {
  token: string;
  workspace?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export function unwrapEntity(payload: unknown): unknown;
export function unwrapEntities(payload: unknown): unknown[];

export class ShortcutClient {
  constructor(options: ShortcutClientOptions);
  request(
    method: string,
    pathname: string,
    options?: { query?: Record<string, unknown>; body?: unknown },
  ): Promise<unknown>;
  whoami(): Promise<{
    id?: string;
    member?: { id?: string };
    [key: string]: unknown;
  }>;
  listWorkflowStates(): Promise<ShortcutWorkflowState[]>;
  getEpic(id: number | string): Promise<ShortcutEpic>;
  listEpicStories(epicId: number | string, options?: { fields?: string }): Promise<ShortcutStory[]>;
  storyLinks(story: ShortcutStory | number | string): Promise<ShortcutStoryLink[]>;
}
