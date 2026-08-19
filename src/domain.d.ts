import type {
  ShortcutStory,
  ShortcutWorkflowState,
} from "./client.js";

export interface StorySummary {
  id: number;
  title?: string;
  app_url?: string;
  state: { id: number; name?: string; type?: string };
  blocked: boolean;
  position?: number | string;
  owners: Array<{ id: string; name?: string }>;
  blocked_by: number[];
  blocks: number[];
  updated_at?: string;
}

export type StatesById = Map<number, ShortcutWorkflowState>;

export function stateIndex(states: ShortcutWorkflowState[]): StatesById;
export function storyState(story: ShortcutStory, states: StatesById): ShortcutWorkflowState;
export function summarizeStory(story: ShortcutStory, states: StatesById): StorySummary;
export function classifyStories(
  stories: ShortcutStory[],
  states: StatesById,
): {
  ready: ShortcutStory[];
  active: ShortcutStory[];
  blocked: ShortcutStory[];
  done: ShortcutStory[];
  other: ShortcutStory[];
};
