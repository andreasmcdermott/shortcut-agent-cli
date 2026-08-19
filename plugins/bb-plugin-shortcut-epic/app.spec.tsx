/** @vitest-environment jsdom */
import { fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { GraphResponse, rpcContract } from "./server.js";

const graph: GraphResponse = {
  project: { id: "proj_1", name: "Agent project" },
  configPath: ".shortcut-agent.json",
  epic: {
    id: 42,
    name: "Ship agent workflow",
    url: "https://app.shortcut.com/acme/epic/42",
  },
  counts: { ready: 1, active: 1, blocked: 0, done: 0, other: 0 },
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
      title: "Dependent",
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
  ],
  edges: [{ source: 1, target: 2 }],
  warnings: [],
  generatedAt: "2026-08-19T17:00:00.000Z",
};

describe("Shortcut Epic nav panel", () => {
  it("renders graph state and refreshes through RPC", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]).toMatchObject({
      id: "epic-graph",
      title: "Shortcut Epic",
      path: "epic",
    });

    type PanelProps = ComponentProps<(typeof app.navPanels)[number]["component"]>;
    const slot = renderSlot<PanelProps, typeof rpcContract>(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: "proj_1" },
        rpc: { loadGraph: () => graph },
      },
    );

    await slot.findByText("Ship agent workflow");
    expect(slot.getByText("Foundation")).toBeTruthy();
    expect(slot.getByText("Dependent")).toBeTruthy();
    expect(
      slot.getByRole("img", { name: "Dependency graph for Ship agent workflow" }),
    ).toBeTruthy();
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "loadGraph", input: { projectId: "proj_1" } },
    ]);

    fireEvent.click(slot.getByRole("button", { name: "Refresh Epic graph" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

    slot.lifecycle.unmount();
  });
});
