import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Markdown,
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  GraphResponse,
  OwnedEpic,
  StoryDetail,
  rpcContract,
} from "./server";
import { layoutGraph, type GraphNode, type NodeStatus } from "./graph.js";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 2;
const ZOOM_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2];
const OWNED_EPICS_CACHE_VERSION = 1;
const OWNED_EPICS_CACHE_TTL_MS = 5 * 60_000;
const GRAPH_CACHE_VERSION = 1;
const GRAPH_CACHE_TTL_MS = 5 * 60_000;

const STATUS_LABELS: Record<NodeStatus, string> = {
  ready: "Ready",
  active: "Active",
  blocked: "Blocked",
  done: "Done",
  other: "Other",
};

function statusClass(status: NodeStatus) {
  if (status === "ready") return "bg-success/10 text-success";
  if (status === "active") return "bg-primary/10 text-primary";
  if (status === "blocked") return "bg-destructive/10 text-destructive";
  if (status === "done") return "bg-muted text-muted-foreground";
  return "bg-secondary text-secondary-foreground";
}

function nodeClass(node: GraphNode) {
  return cn(
    "flex h-full flex-col rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    node.status === "ready" && "border-success/50",
    node.status === "blocked" && "border-destructive/50",
    node.isActive && "border-primary bg-primary/10 ring-2 ring-primary/45",
    node.status === "done" && "opacity-40",
  );
}

function startWorkBlockedReason(node: GraphNode, mutationsEnabled: boolean) {
  if (!mutationsEnabled) {
    return "Enable agent mutations in Extensions → Plugins → Shortcut Agent to claim Stories.";
  }
  if (node.status === "blocked" || node.blocked) return "This Story is blocked.";
  if (node.status === "ready") return null;
  return `This Story is in ${node.stateName} and is not claimable.`;
}

function StoryMenu({
  node,
  mutationsEnabled,
  starting,
  onStartWork,
}: {
  node: GraphNode;
  mutationsEnabled: boolean;
  starting: boolean;
  onStartWork: () => void;
}) {
  const blockedReason = startWorkBlockedReason(node, mutationsEnabled);

  async function copyId() {
    const id = `sc-${node.id}`;
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`Copied ${id}`);
    } catch {
      toast.error(`Could not copy ${id}`);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for sc-${node.id}`}
          title="Story actions"
          className="relative z-10 -my-0.5 -mr-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-sm leading-none text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span aria-hidden="true">…</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle={`Actions for sc-${node.id}`}>
        <DropdownMenuItem
          disabled={starting || blockedReason !== null}
          title={blockedReason ?? undefined}
          onSelect={onStartWork}
        >
          {starting ? "Starting…" : "Start work in bb"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyId()}>Copy ID</DropdownMenuItem>
        {node.url ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => window.open(node.url!, "_blank", "noopener,noreferrer")}
            >
              Open in Shortcut
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StoryNode({
  node,
  mutationsEnabled,
  openInPlugin,
  starting,
  onOpen,
  onStartWork,
}: {
  node: GraphNode;
  mutationsEnabled: boolean;
  openInPlugin: boolean;
  starting: boolean;
  onOpen: () => void;
  onStartWork: () => void;
}) {
  return (
    <div className={cn(nodeClass(node), "relative")}>
      {openInPlugin ? (
        <button
          type="button"
          className="absolute inset-0 rounded-lg"
          aria-label={`View sc-${node.id}: ${node.title} in Shortcut Agent`}
          onClick={onOpen}
        />
      ) : node.url ? (
        <a
          className="absolute inset-0 rounded-lg"
          href={node.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open sc-${node.id}: ${node.title} in Shortcut`}
        />
      ) : null}
      <div className="relative flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">sc-{node.id}</span>
        <div className="flex items-center gap-1">
          {node.blocked && node.isActive ? (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              Blocked
            </span>
          ) : null}
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              statusClass(node.status),
            )}
          >
            {STATUS_LABELS[node.status]}
          </span>
          <StoryMenu
            node={node}
            mutationsEnabled={mutationsEnabled}
            starting={starting}
            onStartWork={onStartWork}
          />
        </div>
      </div>
      <div className="pointer-events-none mt-1.5 break-words text-sm font-medium leading-snug">
        {node.title}
      </div>
      <div className="pointer-events-none relative mt-auto flex min-w-0 items-center justify-between gap-2 pt-2 text-[11px] text-muted-foreground">
        <span className="truncate">{node.owners.join(", ") || node.stateName}</span>
        {node.externalBlockedBy.length > 0 ? (
          <span className="pointer-events-auto shrink-0 text-destructive" title={`External blockers: ${node.externalBlockedBy.join(", ")}`}>
            +{node.externalBlockedBy.length} external
          </span>
        ) : null}
      </div>
    </div>
  );
}

function displayDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function StoryDetailsDialog({
  node,
  projectId,
  onOpenChange,
}: {
  node: GraphNode | null;
  projectId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!node) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let current = true;
    setDetail(null);
    setError(null);
    setLoading(true);
    void rpc
      .call("loadStory", { storyId: node.id, projectId })
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch((cause) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [node, projectId, rpc]);

  const visible = detail?.id === node?.id ? detail : null;
  const updatedAt = displayDate(visible?.updatedAt ?? node?.updatedAt ?? null);

  return (
    <Dialog open={node !== null} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="shortcut-agent-story-summary">
        <DialogHeader>
          <DialogDescription id="shortcut-agent-story-summary">
            sc-{node?.id} · {visible?.stateName ?? node?.stateName ?? "Loading…"}
          </DialogDescription>
          <DialogTitle>{visible?.title ?? node?.title ?? "Story details"}</DialogTitle>
        </DialogHeader>

        <div
          data-testid="story-details-scroll-region"
          className="min-h-0 flex-1 overflow-y-auto pr-1"
        >
          {loading ? (
            <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Icon name="Spinner" className="animate-spin" aria-hidden="true" />
              Loading Story…
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : visible ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {visible.storyType ? (
                  <span className="capitalize">{visible.storyType}</span>
                ) : null}
                {visible.blocked ? (
                  <span className="font-medium text-destructive">Blocked</span>
                ) : null}
                <span>{visible.owners.join(", ") || "Unowned"}</span>
                {updatedAt ? <span>Updated {updatedAt}</span> : null}
              </div>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Description
                </h3>
                {visible.description.trim() ? (
                  <Markdown content={visible.description} className="text-sm text-foreground" />
                ) : (
                  <p className="text-sm text-muted-foreground">No description.</p>
                )}
              </section>

              {visible.comments.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recent comments
                  </h3>
                  <div className="space-y-2">
                    {visible.comments.map((comment) => (
                      <article key={comment.id} className="rounded-md border border-border bg-card p-3">
                        <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                          <span>{comment.author ?? "Shortcut user"}</span>
                          {displayDate(comment.createdAt) ? (
                            <span>{displayDate(comment.createdAt)}</span>
                          ) : null}
                        </div>
                        <Markdown content={comment.text} className="text-sm text-foreground" />
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border pt-4">
          {(visible?.url ?? node?.url) ? (
            <Button asChild size="sm" variant="outline">
              <a
                href={(visible?.url ?? node?.url)!}
                target="_blank"
                rel="noreferrer"
              >
                Open in Shortcut
              </a>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: NodeStatus }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn("text-sm font-semibold", tone && statusClass(tone).split(" ")[1])}>
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function selectedEpicId(subPath: string) {
  if (!/^\d+$/.test(subPath)) return null;
  const value = Number(subPath);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function epicPreferenceKey(projectId: string | null) {
  return `shortcut-agent:last-epic:${projectId ?? "default"}`;
}

function readRememberedEpic(projectId: string | null) {
  try {
    return selectedEpicId(window.localStorage.getItem(epicPreferenceKey(projectId)) ?? "");
  } catch {
    return null;
  }
}

function rememberEpic(projectId: string | null, epicId: number) {
  try {
    window.localStorage.setItem(epicPreferenceKey(projectId), String(epicId));
  } catch {
    // The graph still works when browser storage is unavailable.
  }
}

function forgetEpic(projectId: string | null) {
  try {
    window.localStorage.removeItem(epicPreferenceKey(projectId));
  } catch {
    // The graph still works when browser storage is unavailable.
  }
}

function ownedEpicsCacheKey(projectId: string | null) {
  return `shortcut-agent:owned-epics:${projectId ?? "default"}`;
}

function isOwnedEpic(value: unknown): value is OwnedEpic {
  if (typeof value !== "object" || value === null) return false;
  const epic = value as Partial<OwnedEpic>;
  return (
    Number.isSafeInteger(epic.id) &&
    Number(epic.id) > 0 &&
    typeof epic.name === "string" &&
    (epic.url === null || typeof epic.url === "string")
  );
}

function readOwnedEpicsCache(projectId: string | null) {
  try {
    const key = ownedEpicsCacheKey(projectId);
    const value = window.localStorage.getItem(key);
    if (!value) return null;
    const cached = JSON.parse(value) as {
      version?: unknown;
      cachedAt?: unknown;
      epics?: unknown;
    };
    if (
      cached.version !== OWNED_EPICS_CACHE_VERSION ||
      typeof cached.cachedAt !== "number" ||
      !Number.isFinite(cached.cachedAt) ||
      !Array.isArray(cached.epics) ||
      !cached.epics.every(isOwnedEpic)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return {
      epics: cached.epics,
      fresh: Date.now() - cached.cachedAt < OWNED_EPICS_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

function cacheOwnedEpics(projectId: string | null, epics: OwnedEpic[]) {
  try {
    window.localStorage.setItem(
      ownedEpicsCacheKey(projectId),
      JSON.stringify({
        version: OWNED_EPICS_CACHE_VERSION,
        cachedAt: Date.now(),
        epics,
      }),
    );
  } catch {
    // The picker still works when browser storage is unavailable.
  }
}

function graphCacheKey(projectId: string | null, epicId: number | null) {
  return `shortcut-agent:graph:${projectId ?? "default"}:${epicId ?? "configured"}`;
}

function isGraphNode(value: unknown): value is GraphNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as Partial<GraphNode>;
  return (
    typeof node.id === "number" &&
    Number.isSafeInteger(node.id) &&
    typeof node.title === "string" &&
    (node.url === null || typeof node.url === "string") &&
    typeof node.stateName === "string" &&
    typeof node.stateType === "string" &&
    typeof node.status === "string" &&
    Object.prototype.hasOwnProperty.call(STATUS_LABELS, node.status) &&
    typeof node.isActive === "boolean" &&
    typeof node.blocked === "boolean" &&
    Array.isArray(node.owners) &&
    node.owners.every((owner) => typeof owner === "string") &&
    (node.position === null ||
      (typeof node.position === "number" && Number.isFinite(node.position))) &&
    Array.isArray(node.externalBlockedBy) &&
    node.externalBlockedBy.every((id) => typeof id === "number" && Number.isSafeInteger(id)) &&
    (node.updatedAt === null || typeof node.updatedAt === "string")
  );
}

function isGraphResponse(value: unknown): value is GraphResponse {
  if (typeof value !== "object" || value === null) return false;
  const graph = value as Partial<GraphResponse>;
  const countKeys = ["ready", "active", "blocked", "done", "other"] as const;
  return (
    typeof graph.project?.id === "string" &&
    typeof graph.project.name === "string" &&
    typeof graph.configPath === "string" &&
    typeof graph.epic?.id === "number" &&
    Number.isSafeInteger(graph.epic.id) &&
    graph.epic.id > 0 &&
    typeof graph.epic.name === "string" &&
    (graph.epic.url === null || typeof graph.epic.url === "string") &&
    typeof graph.counts === "object" &&
    graph.counts !== null &&
    countKeys.every(
      (key) =>
        typeof graph.counts?.[key] === "number" &&
        Number.isSafeInteger(graph.counts[key]) &&
        graph.counts[key] >= 0,
    ) &&
    Array.isArray(graph.nodes) &&
    graph.nodes.every(isGraphNode) &&
    Array.isArray(graph.edges) &&
    graph.edges.every(
      (edge) =>
        typeof edge?.source === "number" &&
        Number.isSafeInteger(edge.source) &&
        typeof edge.target === "number" &&
        Number.isSafeInteger(edge.target),
    ) &&
    Array.isArray(graph.warnings) &&
    graph.warnings.every((warning) => typeof warning === "string") &&
    (graph.configuredEpicId === null ||
      (typeof graph.configuredEpicId === "number" &&
        Number.isSafeInteger(graph.configuredEpicId))) &&
    typeof graph.mutationsEnabled === "boolean" &&
    typeof graph.generatedAt === "string"
  );
}

function readGraphCache(projectId: string | null, epicId: number | null) {
  try {
    const key = graphCacheKey(projectId, epicId);
    const value = window.localStorage.getItem(key);
    if (!value) return null;
    const cached = JSON.parse(value) as {
      version?: unknown;
      cachedAt?: unknown;
      graph?: unknown;
    };
    const age = typeof cached.cachedAt === "number" ? Date.now() - cached.cachedAt : -1;
    if (
      cached.version !== GRAPH_CACHE_VERSION ||
      age < 0 ||
      age >= GRAPH_CACHE_TTL_MS ||
      !isGraphResponse(cached.graph)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return cached.graph;
  } catch {
    return null;
  }
}

function cacheGraph(
  projectId: string | null,
  requestedEpicId: number | null,
  graph: GraphResponse,
) {
  try {
    const value = JSON.stringify({
      version: GRAPH_CACHE_VERSION,
      cachedAt: Date.now(),
      graph,
    });
    window.localStorage.setItem(graphCacheKey(projectId, requestedEpicId), value);
    window.localStorage.setItem(graphCacheKey(projectId, graph.epic.id), value);
  } catch {
    // A cold-loading shell remains available when browser storage is unavailable.
  }
}

function EpicPicker({
  value,
  ownedEpics,
  ownedEpicsLoading,
  ownedEpicsError,
  selectedEpicId,
  canUseDefault,
  selectionError,
  onChange,
  onSelectOwned,
  onSubmit,
  onUseDefault,
}: {
  value: string;
  ownedEpics: OwnedEpic[];
  ownedEpicsLoading: boolean;
  ownedEpicsError: string | null;
  selectedEpicId: number | null;
  canUseDefault: boolean;
  selectionError: string | null;
  onChange: (value: string) => void;
  onSelectOwned: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUseDefault: () => void;
}) {
  const selectedOwnedEpic = ownedEpics.some((epic) => epic.id === selectedEpicId)
    ? String(selectedEpicId)
    : "";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="shortcut-agent-owned-epic" className="text-xs text-muted-foreground">
          Owned Epic
        </label>
        <select
          id="shortcut-agent-owned-epic"
          className="h-8 min-w-56 max-w-80 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={selectedOwnedEpic}
          disabled={ownedEpicsLoading || ownedEpics.length === 0}
          onChange={(event) => onSelectOwned(event.target.value)}
        >
          <option value="">
            {ownedEpicsLoading
              ? "Loading owned Epics…"
              : ownedEpics.length === 0
                ? "No active owned Epics"
                : "Choose an active Epic…"}
          </option>
          {ownedEpics.map((epic) => (
            <option key={epic.id} value={epic.id}>
              {epic.name} (epic-{epic.id})
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">or</span>
        <form className="flex items-center gap-2" onSubmit={onSubmit}>
          <label htmlFor="shortcut-agent-epic-id" className="text-xs text-muted-foreground">
            Epic ID
          </label>
          <input
            id="shortcut-agent-epic-id"
            className="h-8 w-28 rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="number"
            min="1"
            step="1"
            required
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline">
            Load
          </Button>
          {canUseDefault ? (
            <Button type="button" size="sm" variant="ghost" onClick={onUseDefault}>
              Use default
            </Button>
          ) : null}
        </form>
      </div>
      {ownedEpicsError ? (
        <div className="text-xs text-muted-foreground">
          {ownedEpics.length > 0
            ? "Could not refresh owned Epics. Showing the cached list."
            : "Could not load owned Epics. Enter an Epic ID manually."}
        </div>
      ) : null}
      {selectionError ? (
        <div className="text-xs text-destructive">{selectionError}</div>
      ) : null}
    </div>
  );
}

function EpicGraph({ subPath }: { subPath: string }) {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { values: settings } = useSettings();
  const openStoriesInPlugin = settings?.openStoriesInPlugin !== false;
  const routeEpicId = useMemo(() => selectedEpicId(subPath), [subPath]);
  const [rememberedEpicId, setRememberedEpicId] = useState(() =>
    routeEpicId === null ? readRememberedEpic(projectId) : null,
  );
  const requestedEpicId = routeEpicId ?? rememberedEpicId;
  const [epicInput, setEpicInput] = useState(() =>
    requestedEpicId === null ? "" : String(requestedEpicId),
  );
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [ownedEpics, setOwnedEpics] = useState<OwnedEpic[]>(
    () => readOwnedEpicsCache(projectId)?.epics ?? [],
  );
  const [ownedEpicsLoading, setOwnedEpicsLoading] = useState(
    () => readOwnedEpicsCache(projectId) === null,
  );
  const [ownedEpicsError, setOwnedEpicsError] = useState<string | null>(null);
  const [data, setData] = useState<GraphResponse | null>(() =>
    readGraphCache(projectId, requestedEpicId),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [startingStoryId, setStartingStoryId] = useState<number | null>(null);
  const [selectedStory, setSelectedStory] = useState<GraphNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const graphScrollerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("loadGraph", {
        projectId,
        epicId: requestedEpicId,
      });
      setData(result);
      cacheGraph(projectId, requestedEpicId, result);
      setEpicInput(String(result.epic.id));
      rememberEpic(projectId, result.epic.id);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId, requestedEpicId, rpc]);

  const loadOwnedEpics = useCallback(async () => {
    const cached = readOwnedEpicsCache(projectId);
    if (cached) {
      setOwnedEpics(cached.epics);
      setOwnedEpicsLoading(false);
      setOwnedEpicsError(null);
      if (cached.fresh) return;
    } else {
      setOwnedEpics([]);
      setOwnedEpicsLoading(true);
    }
    try {
      const result = await rpc.call("listOwnedEpics", { projectId });
      setOwnedEpics(result.epics);
      cacheOwnedEpics(projectId, result.epics);
      setOwnedEpicsError(null);
    } catch (cause) {
      if (!cached) setOwnedEpics([]);
      setOwnedEpicsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOwnedEpicsLoading(false);
    }
  }, [projectId, rpc]);

  const startWork = useCallback(
    async (storyId: number, epicId: number) => {
      setStartingStoryId(storyId);
      try {
        const result = await rpc.call("startWork", { storyId, projectId, epicId });
        toast.success(`Opened a bb thread for sc-${result.storyId}`);
        navigate.toThread(result.threadId);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
        void load();
      } finally {
        setStartingStoryId(null);
      }
    },
    [load, navigate, projectId, rpc],
  );

  useEffect(() => {
    if (routeEpicId !== null) {
      setRememberedEpicId(null);
      setEpicInput(String(routeEpicId));
      return;
    }
    const remembered = readRememberedEpic(projectId);
    setRememberedEpicId(remembered);
    if (remembered !== null) setEpicInput(String(remembered));
  }, [projectId, routeEpicId]);

  useEffect(() => {
    if (requestedEpicId) setEpicInput(String(requestedEpicId));
    setData(readGraphCache(projectId, requestedEpicId));
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void loadOwnedEpics();
  }, [loadOwnedEpics]);

  const chooseEpic = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = Number(epicInput);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setSelectionError("Enter a positive Epic ID.");
      return;
    }
    setSelectionError(null);
    rememberEpic(projectId, id);
    navigate.toPluginPanel("epic", { subPath: String(id) });
  };

  const chooseOwnedEpic = (value: string) => {
    const id = selectedEpicId(value);
    if (id === null) return;
    setSelectionError(null);
    setEpicInput(String(id));
    rememberEpic(projectId, id);
    navigate.toPluginPanel("epic", { subPath: String(id) });
  };

  const useDefaultEpic = () => {
    setSelectionError(null);
    forgetEpic(projectId);
    setRememberedEpicId(null);
    navigate.toPluginPanel("epic", { subPath: "" });
  };

  const picker = (
    <EpicPicker
      value={epicInput}
      ownedEpics={ownedEpics}
      ownedEpicsLoading={ownedEpicsLoading}
      ownedEpicsError={ownedEpicsError}
      selectedEpicId={data?.epic.id ?? requestedEpicId}
      canUseDefault={requestedEpicId !== null}
      selectionError={selectionError}
      onChange={setEpicInput}
      onSelectOwned={chooseOwnedEpic}
      onSubmit={chooseEpic}
      onUseDefault={useDefaultEpic}
    />
  );

  const visibleNodes = useMemo(
    () => (data?.nodes ?? []).filter((node) => showCompleted || node.status !== "done"),
    [data?.nodes, showCompleted],
  );
  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    return (data?.edges ?? []).filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
  }, [data?.edges, visibleNodes]);
  const layout = useMemo(
    () => layoutGraph(visibleNodes, visibleEdges),
    [visibleEdges, visibleNodes],
  );
  const nodeById = useMemo(
    () => new Map(visibleNodes.map((node) => [node.id, node])),
    [visibleNodes],
  );

  const applyZoom = (nextZoom: number, resetScroll = false) => {
    const boundedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    const scroller = graphScrollerRef.current;
    const center = scroller
      ? {
          x: (scroller.scrollLeft + scroller.clientWidth / 2) / zoom,
          y: (scroller.scrollTop + scroller.clientHeight / 2) / zoom,
        }
      : null;
    setZoom(boundedZoom);
    if (!scroller) return;
    window.requestAnimationFrame(() => {
      if (typeof scroller.scrollTo !== "function") return;
      if (resetScroll) {
        scroller.scrollTo({ left: 0, top: 0 });
      } else if (center) {
        scroller.scrollTo({
          left: Math.max(0, center.x * boundedZoom - scroller.clientWidth / 2),
          top: Math.max(0, center.y * boundedZoom - scroller.clientHeight / 2),
        });
      }
    });
  };

  const zoomOut = () => {
    const next = [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
    applyZoom(next ?? MIN_ZOOM);
  };

  const zoomIn = () => {
    const next = ZOOM_STEPS.find((step) => step > zoom + 0.001);
    applyZoom(next ?? MAX_ZOOM);
  };

  const fitGraph = () => {
    const scroller = graphScrollerRef.current;
    if (!scroller || scroller.clientWidth <= 0 || scroller.clientHeight <= 0) return;
    const availableWidth = Math.max(1, scroller.clientWidth - 24);
    const availableHeight = Math.max(1, scroller.clientHeight - 24);
    applyZoom(
      Math.min(1, availableWidth / layout.width, availableHeight / layout.height),
      true,
    );
  };

  if (!data && loading) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="border-b border-border px-4 py-3 md:px-5">
          <div className="text-sm font-medium">Shortcut Agent</div>
          <div className="mt-2">{picker}</div>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Icon name="Spinner" className="animate-spin" aria-hidden="true" />
          Loading Epic graph…
        </div>
      </div>
    );
  }

  if (!data && error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-lg rounded-lg border border-destructive/30 bg-destructive/5 p-5">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <Icon name="AlertTriangle" aria-hidden="true" />
            Epic graph unavailable
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <div className="mt-4">{picker}</div>
          <Button className="mt-4" size="sm" variant="outline" onClick={() => void load()}>
            <Icon name="RotateCcw" aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const warnings = [
    ...data.warnings,
    ...(layout.cyclicNodeIds.length > 0
      ? [`Dependency cycle detected among Stories ${layout.cyclicNodeIds.join(", ")}.`]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-4 py-3 md:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{data.epic.name}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">epic-{data.epic.id}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {data.project.name} · {data.configPath} · prerequisite → dependent
          </div>
          <div className="mt-2">{picker}</div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Count label="ready" value={data.counts.ready} tone="ready" />
          <Count label="active" value={data.counts.active} tone="active" />
          <Count label="blocked" value={data.counts.blocked} tone="blocked" />
          <Count label="done" value={data.counts.done} tone="done" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center rounded-md border border-border bg-background p-0.5"
            role="group"
            aria-label="Graph zoom"
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Zoom out"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
            >
              <span aria-hidden="true">−</span>
            </Button>
            <span
              className="min-w-12 px-1 text-center font-mono text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Zoom in"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
            >
              <span aria-hidden="true">+</span>
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={fitGraph}>
              Fit
            </Button>
          </div>
          {data.counts.done > 0 ? (
            <Button
              size="sm"
              variant={showCompleted ? "secondary" : "outline"}
              aria-pressed={showCompleted}
              onClick={() => setShowCompleted((current) => !current)}
            >
              {showCompleted
                ? "Hide completed"
                : `Show completed (${data.counts.done})`}
            </Button>
          ) : null}
          {data.epic.url ? (
            <Button asChild size="sm" variant="ghost">
              <a href={data.epic.url} target="_blank" rel="noreferrer">
                Open Epic
              </a>
            </Button>
          ) : null}
          <Button
            size="icon"
            variant="outline"
            aria-label="Refresh Epic graph"
            disabled={loading}
            onClick={() => void load()}
          >
            <Icon name="RotateCcw" className={cn(loading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>
      </div>

      {error || warnings.length > 0 ? (
        <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground md:px-5">
          {error ? <span className="text-destructive">Refresh failed: {error}</span> : null}
          {error && warnings.length > 0 ? <span> · </span> : null}
          {warnings.join(" · ")}
        </div>
      ) : null}

      <div ref={graphScrollerRef} className="min-h-0 flex-1 overflow-auto">
        {layout.nodes.length === 0 ? (
          <div className="flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground">
            {data.nodes.length > 0 && data.counts.done === data.nodes.length
              ? `All ${data.counts.done} Stories are complete.`
              : "This Epic has no Stories yet."}
          </div>
        ) : (
          <svg
            width={Math.max(1, Math.round(layout.width * zoom))}
            height={Math.max(1, Math.round(layout.height * zoom))}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Dependency graph for ${data.epic.name}`}
            className="mx-auto block"
          >
            <defs>
              <marker
                id="shortcut-epic-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
              </marker>
            </defs>
            <g aria-hidden="true">
              {layout.edges.map((edge) => {
                const source = nodeById.get(edge.source);
                const target = nodeById.get(edge.target);
                const active = source?.isActive || target?.isActive;
                const complete = source?.status === "done" && target?.status === "done";
                return (
                  <path
                    key={`${edge.source}:${edge.target}`}
                    d={edge.path}
                    className={cn(
                      "fill-none stroke-muted-foreground/45",
                      active && "stroke-primary/75",
                      complete && "opacity-30",
                    )}
                    strokeWidth={active ? 2.25 : 1.5}
                    markerEnd="url(#shortcut-epic-arrow)"
                  />
                );
              })}
            </g>
            {layout.nodes.map((node) => (
              <foreignObject
                key={node.id}
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
              >
                <div className="h-full p-1">
                  <StoryNode
                    node={node}
                    mutationsEnabled={data.mutationsEnabled}
                    openInPlugin={openStoriesInPlugin}
                    starting={startingStoryId === node.id}
                    onOpen={() => setSelectedStory(node)}
                    onStartWork={() => void startWork(node.id, data.epic.id)}
                  />
                </div>
              </foreignObject>
            ))}
          </svg>
        )}
      </div>
      <StoryDetailsDialog
        node={selectedStory}
        projectId={projectId}
        onOpenChange={(open) => {
          if (!open) setSelectedStory(null);
        }}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "epic-graph",
    title: "Shortcut Agent",
    icon: "Workflow",
    path: "epic",
    component: EpicGraph,
  });
});
