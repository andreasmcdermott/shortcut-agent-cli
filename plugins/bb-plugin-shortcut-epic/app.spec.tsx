/** @vitest-environment jsdom */
import { fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { GraphResponse, rpcContract } from "./server.js";

const longStoryTitle =
  "Fix double-escaping in the Emoji-based activity feed rendering for Story updates";

const graph: GraphResponse = {
  project: { id: "proj_1", name: "Agent project" },
  configPath: ".shortcut-agent.json",
  epic: {
    id: 42,
    name: "Ship agent workflow",
    url: "https://app.shortcut.com/acme/epic/42",
  },
  counts: { ready: 1, active: 1, blocked: 0, done: 1, other: 0 },
  nodes: [
    {
      id: 1,
      title: "Foundation",
      url: "https://app.shortcut.com/acme/story/1",
      stateName: "In Progress",
      stateType: "started",
      status: "active",
      isActive: true,
      blocked: false,
      owners: ["Agent owner"],
      position: 1,
      externalBlockedBy: [],
      updatedAt: null,
    },
    {
      id: 2,
      title: longStoryTitle,
      url: "https://app.shortcut.com/acme/story/2",
      stateName: "Ready",
      stateType: "unstarted",
      status: "ready",
      isActive: false,
      blocked: false,
      owners: [],
      position: 2,
      externalBlockedBy: [],
      updatedAt: null,
    },
    {
      id: 3,
      title: "Completed foundation",
      url: "https://app.shortcut.com/acme/story/3",
      stateName: "Done",
      stateType: "done",
      status: "done",
      isActive: false,
      blocked: false,
      owners: ["Agent owner"],
      position: 3,
      externalBlockedBy: [],
      updatedAt: null,
    },
  ],
  edges: [{ source: 1, target: 2 }],
  warnings: [],
  configuredEpicId: 42,
  mutationsEnabled: true,
  generatedAt: "2026-08-19T17:00:00.000Z",
};

describe("Shortcut Agent nav panel", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders graph state and refreshes through RPC", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({
      id: "epic-graph",
      title: "Shortcut Agent",
      path: "epic",
    });

    type PanelProps = ComponentProps<(typeof app.navPanels)[number]["component"]>;
    const slot = renderSlot<PanelProps, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_1" },
        rpc: {
          loadGraph: () => graph,
          startWork: () => ({
            threadId: "thread_1",
            storyId: 2,
            title: longStoryTitle,
          }),
        },
      },
    );

    await slot.findByText("Ship agent workflow");
    expect(slot.getByText("Foundation")).toBeTruthy();
    const title = slot.getByText(longStoryTitle);
    expect(title.classList.contains("line-clamp-2")).toBe(false);
    expect(title.classList.contains("break-words")).toBe(true);
    expect(slot.queryByText("Completed foundation")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Show completed (1)" }));
    expect(slot.getByText("Completed foundation")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Hide completed" }));
    expect(slot.queryByText("Completed foundation")).toBeNull();
    const graphSvg = slot.getByRole("img", {
      name: "Dependency graph for Ship agent workflow",
    });
    expect(graphSvg.getAttribute("width")).toBe("720");
    expect(slot.getByText("100%")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Zoom out" }));
    expect(graphSvg.getAttribute("width")).toBe("540");
    expect(slot.getByText("75%")).toBeTruthy();

    const scroller = graphSvg.parentElement!;
    Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 360 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 180 });
    fireEvent.click(slot.getByRole("button", { name: "Fit" }));
    expect(slot.getByText("43%")).toBeTruthy();

    expect(slot.inspection.rpcCalls).toEqual([
      { method: "loadGraph", input: { projectId: "proj_1", epicId: null } },
    ]);

    const epicInput = slot.getByRole("spinbutton", { name: "Epic ID" });
    expect((epicInput as HTMLInputElement).value).toBe("42");
    fireEvent.change(epicInput, { target: { value: "84" } });
    fireEvent.click(slot.getByRole("button", { name: "Load" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "epic",
      options: { subPath: "84" },
    });
    expect(window.localStorage.getItem("shortcut-agent:last-epic:proj_1")).toBe("84");

    fireEvent.click(slot.getByRole("button", { name: "Refresh Epic graph" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

    slot.lifecycle.unmount();
  });

  it("claims a ready Story from the card menu and opens the new thread", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    type PanelProps = ComponentProps<(typeof app.navPanels)[number]["component"]>;
    const slot = renderSlot<PanelProps, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_1" },
        rpc: {
          loadGraph: () => graph,
          startWork: () => ({
            threadId: "thread_1",
            storyId: 2,
            title: longStoryTitle,
          }),
        },
      },
    );

    await slot.findByText("Ship agent workflow");
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Actions for sc-2" }),
      { button: 0, pointerType: "mouse" },
    );

    const startItem = await slot.findByRole("menuitem", { name: "Start work in bb" });
    fireEvent.click(startItem);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toContainEqual({
        method: "startWork",
        input: { storyId: 2, projectId: "proj_1", epicId: 42 },
      }),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thread_1",
    });

    slot.lifecycle.unmount();
  });

  it("does not offer a claim for Stories that are not ready", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    type PanelProps = ComponentProps<(typeof app.navPanels)[number]["component"]>;
    const slot = renderSlot<PanelProps, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_1" },
        rpc: {
          loadGraph: () => ({ ...graph, mutationsEnabled: false }),
          startWork: () => ({
            threadId: "thread_1",
            storyId: 2,
            title: longStoryTitle,
          }),
        },
      },
    );

    await slot.findByText("Ship agent workflow");
    fireEvent.pointerDown(
      slot.getByRole("button", { name: "Actions for sc-1" }),
      { button: 0, pointerType: "mouse" },
    );

    const startItem = await slot.findByRole("menuitem", { name: "Start work in bb" });
    expect(startItem.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(startItem);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "startWork"),
    ).toBe(false);

    slot.lifecycle.unmount();
  });

  it("restores the last opened Epic for the current bb project", async () => {
    window.localStorage.setItem("shortcut-agent:last-epic:proj_1", "84");
    const app = await loadPluginApp(() => import("./app.js"));
    type PanelProps = ComponentProps<(typeof app.navPanels)[number]["component"]>;
    const slot = renderSlot<PanelProps, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_1" },
        rpc: {
          loadGraph: () => graph,
          startWork: () => ({
            threadId: "thread_1",
            storyId: 2,
            title: longStoryTitle,
          }),
        },
      },
    );

    await slot.findByText("Ship agent workflow");
    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "loadGraph",
      input: { projectId: "proj_1", epicId: 84 },
    });

    slot.lifecycle.unmount();
  });
});
