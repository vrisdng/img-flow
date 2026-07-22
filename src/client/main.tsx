import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FolderPlus,
  ImagePlus,
  LoaderCircle,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import "./styles.css";
import "./progress.css";
import "./ux.css";
import "./graph.css";
import "./group-chips.css";

type Project = { id: string; name: string };
type Material = {
  id: string;
  label: string;
  storage_path: string;
  width: number;
  height: number;
};
type Checkpoint = {
  id: string;
  job_id: string;
  parent_checkpoint_id: string | null;
  prompt_version_id: string;
  prompt_text: string;
  storage_path: string;
  width: number;
  height: number;
  created_at: string;
};
type Group = { id: string; label: string; color: string; notes: string };
type GroupMember = { group_id: string; material_id: string; position: number };
type CanvasNode = {
  id: string;
  node_type: "material" | "group" | "generation" | "checkpoint";
  entity_id: string | null;
  position_x: number;
  position_y: number;
  config_json: any;
};
type CanvasEdge = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  position: number;
};
type Job = {
  id: string;
  status: string;
  stage: string;
  progress: number;
  attempt_count: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
  snapshot: {
    prompt: string;
    parentCheckpointId: string | null;
    materialIds: string[];
    groupSnapshots?: {
      label: string;
      notes?: string;
      path: string[];
      materialIds: string[];
    }[];
    model: string;
    variationIndex: number;
    settings: Record<string, string>;
  };
};
type Workspace = {
  project: Project;
  materials: Material[];
  checkpoints: Checkpoint[];
  jobs: Job[];
  groups: Group[];
  groupMembers: GroupMember[];
  canvasNodes: CanvasNode[];
  canvasEdges: CanvasEdge[];
};

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers:
      options?.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const fileUrl = (storagePath: string) =>
  `/api/files/${storagePath.split("/").map(encodeURIComponent).join("/")}`;

function ImageNode({ data, selected }: NodeProps) {
  const item = data.item as Checkpoint;
  return (
    <div className={`image-node ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Top} />
      <img src={fileUrl(item.storage_path)} alt={item.prompt_text} />
      <div>
        <span>{item.prompt_text}</span>
        <small>
          {item.width} × {item.height}
        </small>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
function MaterialNode({ data }: NodeProps) {
  const item = data.item as Material;
  return (
    <div className="material-node">
      <Handle type="source" position={Position.Right} />
      <img
        src={fileUrl(item.storage_path)}
        title="Open full-size preview"
        onDoubleClick={() => (data.onPreview as any)(item.id)}
      />
      <span>{item.label}</span>
    </div>
  );
}
function GroupNode({ data }: NodeProps) {
  const group = data.group as Group;
  const items = data.items as Material[];
  return (
    <div
      className={`group-node ${data.selectedInput ? "input-selected" : ""}`}
      style={{ borderColor: group.color }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.stopPropagation();
        const materialId = e.dataTransfer.getData("application/x-material");
        if (materialId) (data.onMaterialDrop as any)(materialId, group.id);
      }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <strong>{group.label}</strong>
      <small>
        {items.length} material{items.length === 1 ? "" : "s"}
      </small>
      <textarea
        className="nodrag"
        defaultValue={group.notes ?? ""}
        placeholder="Group notes for the image prompt…"
        onClick={(event) => event.stopPropagation()}
        onBlur={(event) => (data.onNotes as any)(group.id, event.target.value)}
      />
      <div>
        {items.slice(0, 5).map((m, i) => (
          <span key={m.id}>
            <b>{i + 1}</b>
            <img
              src={fileUrl(m.storage_path)}
              title="Open full-size preview"
              onDoubleClick={(event) => {
                event.stopPropagation();
                (data.onPreview as any)(m.id);
              }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
const nodeTypes = {
  image: ImageNode,
  material: MaterialNode,
  group: GroupNode,
};

function layout(checkpoints: Checkpoint[]) {
  const children = new Map<string | null, Checkpoint[]>();
  checkpoints.forEach((cp) =>
    children.set(cp.parent_checkpoint_id, [
      ...(children.get(cp.parent_checkpoint_id) ?? []),
      cp,
    ]),
  );
  const positions = new Map<string, { x: number; y: number }>();
  let leaf = 0;
  const place = (item: Checkpoint, depth: number): number => {
    const kids = children.get(item.id) ?? [];
    const x = kids.length
      ? kids
          .map((child) => place(child, depth + 1))
          .reduce((a, b) => a + b, 0) / kids.length
      : leaf++ * 250;
    positions.set(item.id, { x, y: depth * 250 });
    return x;
  };
  (children.get(null) ?? []).forEach((root) => place(root, 0));
  checkpoints
    .filter((cp) => !positions.has(cp.id))
    .forEach((cp) => place(cp, 0));
  return positions;
}

function GenerationTrace({ job }: { job?: Job }) {
  if (!job)
    return <p className="trace-empty">Generation record unavailable.</p>;
  const steps = [
    {
      label: "Request queued",
      done: true,
      detail: new Date(job.created_at).toLocaleString(),
    },
    {
      label:
        job.snapshot.parentCheckpointId || job.snapshot.materialIds.length
          ? "Prepared source images"
          : "Prepared isolated prompt",
      done: job.status !== "queued",
      detail: `${job.snapshot.materialIds.length} material${job.snapshot.materialIds.length === 1 ? "" : "s"}`,
    },
    {
      label: "Called OpenAI image model",
      done: ["running", "retrying", "completed", "failed"].includes(job.status),
      detail: job.snapshot.model,
    },
    {
      label: "Validated and stored output",
      done: job.status === "completed",
      detail:
        job.status === "completed" ? "Supabase private storage" : "Pending",
    },
    {
      label: "Created checkpoint",
      done: job.status === "completed",
      detail:
        job.status === "completed"
          ? new Date(job.updated_at).toLocaleString()
          : "Pending",
    },
  ];
  return (
    <div className="trace">
      <p>
        This is an execution trace. OpenAI does not return private model
        reasoning.
      </p>
      {steps.map((step, index) => (
        <div className={step.done ? "done" : ""} key={step.label}>
          <span>{step.done ? <Check size={11} /> : index + 1}</span>
          <section>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </section>
        </div>
      ))}
      <dl>
        <dt>Prompt</dt>
        <dd>{job.snapshot.prompt}</dd>
        {job.snapshot.groupSnapshots?.length && (
          <>
            <dt>Groups</dt>
            <dd>
              {job.snapshot.groupSnapshots
                .map((g) => g.path.join(" › "))
                .join(", ")}
            </dd>
          </>
        )}
        <dt>Materials</dt>
        <dd>{job.snapshot.materialIds.length} resolved input(s)</dd>
        <dt>Settings</dt>
        <dd>
          {Object.entries(job.snapshot.settings)
            .map(([key, value]) => `${key}: ${value}`)
            .join(" · ")}
        </dd>
        <dt>Attempts</dt>
        <dd>{job.attempt_count || 0}</dd>
        {job.error_message && (
          <>
            <dt>Error</dt>
            <dd>{job.error_message}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function App() {
  const pathProject = () =>
    window.location.pathname.match(/^\/projects\/([0-9a-f-]+)$/i)?.[1] ?? null;
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(pathProject);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState("");
  const [variations, setVariations] = useState(1);
  const [materials, setMaterials] = useState<Set<string>>(new Set());
  const [quickGroups, setQuickGroups] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [materialPreviewId, setMaterialPreviewId] = useState<string | null>(
    null,
  );
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [membershipChoice, setMembershipChoice] = useState<{
    materialId: string;
    groupId: string;
  } | null>(null);
  const loadSequence = useRef(0);
  const workspaceCache = useRef(new Map<string, Workspace>());
  const navigateProject = useCallback(
    (next: string | null, replace = false) => {
      const url = next ? `/projects/${next}` : "/";
      window.history[replace ? "replaceState" : "pushState"]({}, "", url);
      setProjectId(next);
    },
    [],
  );
  const refreshProjects = useCallback(async () => {
    const data = await api<Project[]>("/api/projects");
    setProjects(data);
    setProjectId((current) => {
      if (current) return current;
      const first = data[0]?.id ?? null;
      if (first) window.history.replaceState({}, "", `/projects/${first}`);
      return first;
    });
  }, []);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const requestedProject = projectId;
    const sequence = ++loadSequence.current;
    const data = await api<Workspace>(
      `/api/projects/${requestedProject}/workspace`,
    );
    workspaceCache.current.set(requestedProject, data);
    if (sequence === loadSequence.current) setWorkspace(data);
  }, [projectId]);
  useEffect(() => {
    const pop = () => setProjectId(pathProject());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);
  useEffect(() => {
    loadSequence.current++;
    setWorkspace(
      projectId ? (workspaceCache.current.get(projectId) ?? null) : null,
    );
    setSelected(null);
    setSelectedNodeId(null);
    setChecked(new Set());
    setMaterials(new Set());
    setQuickGroups(new Set());
    setPreviewId(null);
    setMaterialPreviewId(null);
    void refresh();
  }, [projectId, refresh]);
  useEffect(() => {
    if (!projectId) return;
    const events = new EventSource(`/api/events?projectId=${projectId}`);
    let refreshTimer: number | undefined;
    const update = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 500);
    };
    const progress = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as {
        jobId: string;
        stage: string;
        progress: number;
      };
      setWorkspace((current) =>
        current
          ? {
              ...current,
              jobs: current.jobs.map((job) =>
                job.id === payload.jobId
                  ? {
                      ...job,
                      stage: payload.stage,
                      progress: payload.progress,
                    }
                  : job,
              ),
            }
          : current,
      );
    };
    events.addEventListener("job.progress", progress as EventListener);
    [
      "job.queued",
      "job.running",
      "job.retrying",
      "job.completed",
      "job.failed",
      "job.cancelled",
      "material.created",
      "material.deleted",
      "graph.updated",
    ].forEach((type) => events.addEventListener(type, update));
    return () => {
      window.clearTimeout(refreshTimer);
      events.removeEventListener("job.progress", progress as EventListener);
      events.close();
    };
  }, [projectId, refresh]);

  const graph = useMemo(() => {
    if (!workspace) return { nodes: [], edges: [] };
    const positions = layout(workspace.checkpoints);
    const persistedCheckpointIds = new Set(
      workspace.canvasNodes
        .filter((n) => n.node_type === "checkpoint")
        .map((n) => n.entity_id),
    );
    const persisted = workspace.canvasNodes
      .map((node) => {
        const common = {
          id: node.id,
          position: { x: node.position_x, y: node.position_y },
        };
        if (node.node_type === "group") {
          const group = workspace.groups.find((g) => g.id === node.entity_id)!;
          const ids = workspace.groupMembers
            .filter((m) => m.group_id === group?.id)
            .sort((a, b) => a.position - b.position)
            .map((m) => m.material_id);
          return {
            ...common,
            type: "group",
            data: {
              group,
              items: ids
                .map((mid) => workspace.materials.find((m) => m.id === mid))
                .filter(Boolean),
              onMaterialDrop: handleMaterialDrop,
              onPreview: setMaterialPreviewId,
              onNotes: updateGroupNotes,
              selectedInput: quickGroups.has(group.id),
            },
          };
        }
        if (node.node_type === "material")
          return {
            ...common,
            type: "material",
            data: {
              item: workspace.materials.find((m) => m.id === node.entity_id),
              onPreview: setMaterialPreviewId,
            },
          };
        if (node.node_type === "generation") return null;
        return {
          ...common,
          type: "image",
          data: {
            item: workspace.checkpoints.find((c) => c.id === node.entity_id),
          },
        };
      })
      .filter(
        (n: any) => n && (n.data?.item !== undefined || n.type === "group"),
      );
    const legacy = workspace.checkpoints
      .filter((cp) => !persistedCheckpointIds.has(cp.id))
      .map((cp) => ({
        id: cp.id,
        type: "image",
        position: positions.get(cp.id)!,
        data: { item: cp },
      }));
    const nodes = [...persisted, ...legacy].filter(Boolean) as any[];
    const visibleIds = new Set(nodes.map((node) => node.id));
    const compositionEdges = workspace.canvasEdges
      .filter(
        (edge) =>
          edge.edge_type === "group_include" &&
          visibleIds.has(edge.source_node_id) &&
          visibleIds.has(edge.target_node_id),
      )
      .map((edge) => ({
        id: edge.id,
        source: edge.source_node_id,
        target: edge.target_node_id,
        style: { stroke: "#8d72ad", strokeWidth: 2 },
      }));
    const checkpointNodeIds = new Map(
      workspace.checkpoints.map((checkpoint) => [
        checkpoint.id,
        workspace.canvasNodes.find(
          (node) =>
            node.node_type === "checkpoint" && node.entity_id === checkpoint.id,
        )?.id ?? checkpoint.id,
      ]),
    );
    const historyEdges = workspace.checkpoints
      .filter((checkpoint) => checkpoint.parent_checkpoint_id)
      .map((checkpoint) => ({
        id: `history-${checkpoint.id}`,
        source: checkpointNodeIds.get(checkpoint.parent_checkpoint_id!)!,
        target: checkpointNodeIds.get(checkpoint.id)!,
        animated: false,
        style: { stroke: "#777", strokeWidth: 2 },
      }));
    return { nodes, edges: [...compositionEdges, ...historyEdges] };
  }, [
    workspace?.canvasNodes,
    workspace?.canvasEdges,
    workspace?.checkpoints,
    workspace?.groups,
    workspace?.groupMembers,
    workspace?.materials,
    quickGroups,
  ]);
  const selectedCheckpoint = workspace?.checkpoints.find(
    (cp) => cp.id === selected,
  );
  const selectedJob = workspace?.jobs.find(
    (job) => job.id === selectedCheckpoint?.job_id,
  );
  const previewCheckpoint = workspace?.checkpoints.find(
    (cp) => cp.id === previewId,
  );
  const previewIndex =
    workspace?.checkpoints.findIndex((cp) => cp.id === previewId) ?? -1;
  const previewMaterial = workspace?.materials.find(
    (material) => material.id === materialPreviewId,
  );
  const materialPreviewIndex =
    workspace?.materials.findIndex(
      (material) => material.id === materialPreviewId,
    ) ?? -1;

  useEffect(() => {
    setFlowNodes(graph.nodes);
    setFlowEdges(graph.edges);
  }, [graph.nodes, graph.edges, setFlowNodes, setFlowEdges]);

  async function createProject() {
    const name = window.prompt("Project name", "Untitled exploration");
    if (!name) return;
    const project = await api<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await refreshProjects();
    navigateProject(project.id);
  }
  async function createGroup() {
    if (!projectId) return;
    const label = window.prompt("Group label", "Character");
    if (!label) return;
    await api(`/api/projects/${projectId}/groups`, {
      method: "POST",
      body: JSON.stringify({ label, x: 120, y: 120 }),
    });
    await refresh();
  }
  async function handleMaterialDrop(materialId: string, groupId: string) {
    if (!workspace) return;
    const existing = workspace.groupMembers.some(
      (m) => m.material_id === materialId,
    );
    if (existing) setMembershipChoice({ materialId, groupId });
    else {
      await api(`/api/groups/${groupId}/members`, {
        method: "POST",
        body: JSON.stringify({ materialId, mode: "copy" }),
      });
      await refresh();
    }
  }
  async function setMembership(mode: "copy" | "move") {
    if (!membershipChoice) return;
    await api(`/api/groups/${membershipChoice.groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ materialId: membershipChoice.materialId, mode }),
    });
    setMembershipChoice(null);
    await refresh();
  }
  async function updateGroupNotes(groupId: string, notes: string) {
    const group = workspace?.groups.find((item) => item.id === groupId);
    if (!group || group.notes === notes) return;
    await api(`/api/groups/${groupId}`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    });
    await refresh();
  }
  async function connectNodes(connection: Connection) {
    if (!projectId || !connection.source || !connection.target) return;
    try {
      const sourceNode = graph.nodes.find(
        (node) => node.id === connection.source,
      );
      const targetNode = graph.nodes.find(
        (node) => node.id === connection.target,
      );
      await api(`/api/projects/${projectId}/canvas/edges`, {
        method: "POST",
        body: JSON.stringify({
          source: connection.source,
          target: connection.target,
          sourcePosition: sourceNode?.position,
          targetPosition: targetNode?.position,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid connection.");
    }
  }
  async function persistPosition(node: any) {
    if (workspace?.canvasNodes.some((n) => n.id === node.id))
      await api(`/api/canvas/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({ x: node.position.x, y: node.position.y }),
      });
  }
  async function deleteNodes(nodes: Node[]) {
    if (!workspace || !nodes.length) return;
    const persisted = nodes
      .map((node) => workspace.canvasNodes.find((item) => item.id === node.id))
      .filter(Boolean) as Workspace["canvasNodes"];
    if (nodes.length !== persisted.length) {
      setError(
        "Historical checkpoint images cannot be removed because they preserve generation history.",
      );
      await refresh();
      return;
    }
    const groupCount = persisted.filter(
      (node) => node.node_type === "group",
    ).length;
    const message = groupCount
      ? `Delete ${nodes.length === 1 ? "this node" : `${nodes.length} nodes`}? This also deletes ${groupCount === 1 ? "the material group" : `${groupCount} material groups`} and its memberships.`
      : `Delete ${nodes.length === 1 ? "this node" : `${nodes.length} nodes`} from the workspace?`;
    if (!window.confirm(message)) {
      await refresh();
      return;
    }
    setError("");
    try {
      await Promise.all(
        persisted.map((node) =>
          api(`/api/canvas/nodes/${node.id}`, { method: "DELETE" }),
        ),
      );
      setSelectedNodeId(null);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete node.");
      await refresh();
    }
  }
  async function dropOnCanvas(event: React.DragEvent) {
    event.preventDefault();
    if (!projectId || !flow) return;
    const materialId = event.dataTransfer.getData("application/x-material");
    if (!materialId) return;
    const point = flow.screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    await api(`/api/projects/${projectId}/canvas/nodes`, {
      method: "POST",
      body: JSON.stringify({
        nodeType: "material",
        entityId: materialId,
        x: point.x,
        y: point.y,
        config: {},
      }),
    });
    await refresh();
  }
  async function submit() {
    if (!projectId || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${projectId}/jobs`, {
        method: "POST",
        body: JSON.stringify({
          prompt,
          parentCheckpointId: selected,
          parentPromptVersionId: selectedCheckpoint?.prompt_version_id ?? null,
          materialIds: [...materials],
          groupIds: [...quickGroups],
          variations,
          idempotencyKey: crypto.randomUUID(),
          settings: {
            size: "1024x1024",
            quality: "medium",
            background: "auto",
            outputFormat: "png",
          },
        }),
      });
      setPrompt("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue job.");
    } finally {
      setBusy(false);
    }
  }
  async function uploadMaterial(file: File) {
    if (!projectId) return;
    const form = new FormData();
    form.append("image", file);
    form.append("label", file.name);
    setError("");
    try {
      await api(`/api/projects/${projectId}/materials`, {
        method: "POST",
        body: form,
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    }
  }
  async function downloadSelection() {
    const response = await fetch("/api/checkpoints/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...checked] }),
    });
    if (!response.ok) return setError("Could not create download.");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "image-flow-selection.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app-shell">
      <aside className="projects-panel">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={18} />
          </span>
          <strong>Image Flow</strong>
        </div>
        <div className="aside-title">
          <span>Projects</span>
          <button onClick={createProject} title="New project">
            <Plus size={16} />
          </button>
        </div>
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className={project.id === projectId ? "active" : ""}
              onClick={() => navigateProject(project.id)}
            >
              <span>{project.name.slice(0, 1).toUpperCase()}</span>
              {project.name}
            </button>
          ))}
        </div>
        {workspace && (
          <button
            className="archive"
            onClick={async () => {
              await api(`/api/projects/${workspace.project.id}`, {
                method: "PATCH",
                body: JSON.stringify({ archived: true }),
              });
              navigateProject(null);
              setWorkspace(null);
              await refreshProjects();
            }}
          >
            <Archive size={15} /> Archive project
          </button>
        )}
      </aside>

      <main>
        <header>
          <div>
            <small>WORKSPACE</small>
            <h1>{workspace?.project.name ?? "Create your first project"}</h1>
          </div>
          <div className="header-actions">
            {workspace && (
              <>
                <button className="secondary" onClick={createGroup}>
                  <FolderPlus size={16} /> Group
                </button>
                {selectedNodeId && (
                  <button
                    className="secondary danger"
                    onClick={() => {
                      const node = graph.nodes.find(
                        (item) => item.id === selectedNodeId,
                      );
                      if (node) void deleteNodes([node]);
                    }}
                  >
                    <Trash2 size={16} /> Delete node
                  </button>
                )}
              </>
            )}
            {!!workspace?.checkpoints.length && (
              <button
                className="secondary"
                onClick={() =>
                  setPreviewId(selected ?? workspace.checkpoints[0].id)
                }
              >
                <Eye size={16} /> Gallery
              </button>
            )}
            {checked.size > 0 && (
              <button className="secondary" onClick={downloadSelection}>
                <Download size={16} /> Download {checked.size}
              </button>
            )}
          </div>
        </header>
        <section
          className="canvas"
          onDragOver={(e) => e.preventDefault()}
          onDrop={dropOnCanvas}
        >
          {workspace ? (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              fitView
              onInit={setFlow}
              onConnect={connectNodes}
              onNodeDragStop={(_, node) => void persistPosition(node)}
              onNodesDelete={(nodes) => void deleteNodes(nodes)}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                const groupNode = workspace.canvasNodes.find(
                  (item) => item.id === node.id && item.node_type === "group",
                );
                if (groupNode?.entity_id) {
                  setQuickGroups((current) => {
                    const next = new Set(current);
                    next.has(groupNode.entity_id!)
                      ? next.delete(groupNode.entity_id!)
                      : next.add(groupNode.entity_id!);
                    return next;
                  });
                }
                const materialNode = workspace.canvasNodes.find(
                  (item) =>
                    item.id === node.id && item.node_type === "material",
                );
                if (materialNode?.entity_id) {
                  setMaterials((current) => {
                    const next = new Set(current);
                    next.has(materialNode.entity_id!)
                      ? next.delete(materialNode.entity_id!)
                      : next.size < 15 && next.add(materialNode.entity_id!);
                    return next;
                  });
                }
                const cp = workspace.canvasNodes.find(
                  (n) => n.id === node.id && n.node_type === "checkpoint",
                );
                setSelected(
                  cp?.entity_id ??
                    (workspace.checkpoints.some((c) => c.id === node.id)
                      ? node.id
                      : null),
                );
              }}
              onNodeDoubleClick={(_, node) => {
                const cp = workspace.canvasNodes.find(
                  (n) => n.id === node.id && n.node_type === "checkpoint",
                );
                if (cp?.entity_id) setPreviewId(cp.entity_id);
              }}
              onPaneClick={() => {
                setSelected(null);
                setSelectedNodeId(null);
              }}
            >
              <Background color="#d8d7d2" gap={24} />
              <Controls showInteractive={false} />
            </ReactFlow>
          ) : (
            <div className="empty">
              <div>
                <ImagePlus size={28} />
              </div>
              <h2>Your idea starts here</h2>
              <p>
                Describe an image below. Every result becomes a checkpoint you
                can safely branch from.
              </p>
            </div>
          )}
        </section>
        <section className="composer">
          <div className="context-row">
            {selectedCheckpoint && (
              <span className="context">
                <img src={fileUrl(selectedCheckpoint.storage_path)} /> Base
                checkpoint
                <button onClick={() => setSelected(null)}>
                  <X size={13} />
                </button>
              </span>
            )}
            {!!quickGroups.size && (
              <span className="context">
                {quickGroups.size} selected group
                {quickGroups.size === 1 ? "" : "s"}
                <button onClick={() => setQuickGroups(new Set())}>
                  <X size={13} />
                </button>
              </span>
            )}
            {!selectedCheckpoint && !quickGroups.size && (
              <span className="fresh">
                New root generation · isolated context
              </span>
            )}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              selected
                ? "Describe what should change…"
                : "Describe the image you want to create…"
            }
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
            }}
          />
          <div className="compose-actions">
            <div className="variation-control">
              <span>Variations</span>
              {[1, 2, 3, 4].map((n) => (
                <button
                  className={n === variations ? "active" : ""}
                  onClick={() => setVariations(n)}
                  key={n}
                >
                  {n}
                </button>
              ))}
            </div>
            <button
              className="generate"
              disabled={busy || !prompt.trim() || !projectId}
              onClick={submit}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Sparkles size={17} />
              )}{" "}
              Queue generation
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </main>

      <aside className="right-panel">
        <section className="materials">
          <div className="panel-title">
            <div>
              <small>INPUTS</small>
              <h3>
                Materials <em>{materials.size}/15</em>
              </h3>
            </div>
            <label title="Upload reference">
              <Upload size={16} />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) =>
                  e.target.files?.[0] && void uploadMaterial(e.target.files[0])
                }
              />
            </label>
          </div>
          <p>
            Click for quick mode, or drag onto the canvas/group. Numbers show
            model order.
          </p>
          {!!workspace?.groups.length && (
            <div className="group-chips">
              {workspace.groups.map((group) => (
                <button
                  key={group.id}
                  className={quickGroups.has(group.id) ? "active" : ""}
                  style={{ borderColor: group.color }}
                  onClick={() =>
                    setQuickGroups((current) => {
                      const next = new Set(current);
                      next.has(group.id)
                        ? next.delete(group.id)
                        : next.add(group.id);
                      return next;
                    })
                  }
                >
                  {group.label}
                </button>
              ))}
            </div>
          )}
          <div className="material-grid">
            {workspace?.materials.map((item) => {
              const number = [...materials].indexOf(item.id) + 1;
              return (
                <button
                  draggable
                  title="Click to select; double-click to preview full size"
                  onDragStart={(e) =>
                    e.dataTransfer.setData("application/x-material", item.id)
                  }
                  key={item.id}
                  className={materials.has(item.id) ? "selected" : ""}
                  onClick={() =>
                    setMaterials((current) => {
                      const next = new Set(current);
                      if (next.has(item.id)) {
                        next.delete(item.id);
                        setError("");
                      } else if (next.size >= 15) {
                        setError(
                          "You can select up to 15 materials at a time.",
                        );
                      } else {
                        next.add(item.id);
                        setError("");
                      }
                      return next;
                    })
                  }
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    setMaterialPreviewId(item.id);
                  }}
                >
                  <img src={fileUrl(item.storage_path)} />
                  <span>{number > 0 && number}</span>
                  <small>{item.label}</small>
                </button>
              );
            })}
          </div>
        </section>
        {selectedCheckpoint && (
          <section className="inspector">
            <small>CHECKPOINT</small>
            <div className="preview-select">
              <img
                onClick={() => setPreviewId(selectedCheckpoint.id)}
                src={fileUrl(selectedCheckpoint.storage_path)}
              />
              <button
                onClick={() =>
                  setChecked((current) => {
                    const next = new Set(current);
                    next.has(selectedCheckpoint.id)
                      ? next.delete(selectedCheckpoint.id)
                      : next.add(selectedCheckpoint.id);
                    return next;
                  })
                }
              >
                {checked.has(selectedCheckpoint.id) ? (
                  <Check size={15} />
                ) : (
                  <Square size={15} />
                )}{" "}
                Select
              </button>
            </div>
            <button
              className="open-preview"
              onClick={() => setPreviewId(selectedCheckpoint.id)}
            >
              <Eye size={14} /> Open large preview
            </button>
            <p>{selectedCheckpoint.prompt_text}</p>
            <div className="meta">
              <span>
                {selectedCheckpoint.width} × {selectedCheckpoint.height}
              </span>
              <span>
                {new Date(selectedCheckpoint.created_at).toLocaleString()}
              </span>
            </div>
            <details className="trace-details">
              <summary>Generation trace</summary>
              <GenerationTrace job={selectedJob} />
            </details>
            <a
              className="download"
              href={`/api/checkpoints/${selectedCheckpoint.id}/download`}
            >
              <Download size={15} /> Download image
            </a>
          </section>
        )}
        <section className="jobs">
          <div className="panel-title">
            <div>
              <small>ACTIVITY</small>
              <h3>Jobs</h3>
            </div>
            <span className="live-dot">LIVE</span>
          </div>
          <div className="job-list">
            {workspace?.jobs.map((job) => (
              <div className="job" key={job.id}>
                <div className={`status ${job.status}`}>
                  {["running", "retrying"].includes(job.status) ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : job.status === "completed" ? (
                    <Check size={14} />
                  ) : job.status === "failed" ? (
                    <X size={14} />
                  ) : (
                    <span />
                  )}
                </div>
                <div className="job-copy">
                  <strong>{job.snapshot.prompt}</strong>
                  <small>
                    {job.stage || job.status}
                    {job.attempt_count ? ` · attempt ${job.attempt_count}` : ""}
                    {job.snapshot.variationIndex
                      ? ` · variation ${job.snapshot.variationIndex + 1}`
                      : ""}
                  </small>
                  <div
                    className="progress-track"
                    title={
                      job.stage?.includes("estimated")
                        ? "OpenAI does not expose exact image-generation progress; this portion is estimated."
                        : job.stage
                    }
                  >
                    <span style={{ width: `${job.progress ?? 0}%` }} />
                  </div>
                  <div className="progress-caption">
                    <span>
                      {job.stage?.includes("estimated")
                        ? "Estimated progress"
                        : "Progress"}
                    </span>
                    <b>{job.progress ?? 0}%</b>
                  </div>
                  {job.error_message && <em>{job.error_message}</em>}
                  <details className="trace-details">
                    <summary>Generation trace</summary>
                    <GenerationTrace job={job} />
                  </details>
                </div>
                <div className="job-actions">
                  {["queued", "running", "retrying"].includes(job.status) && (
                    <button
                      title="Cancel"
                      onClick={() =>
                        void api(`/api/jobs/${job.id}/cancel`, {
                          method: "POST",
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  )}
                  {job.status === "failed" && (
                    <button
                      title="Retry identical request"
                      onClick={() =>
                        void api(`/api/jobs/${job.id}/retry`, {
                          method: "POST",
                        })
                      }
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>
      {membershipChoice && (
        <div className="choice-modal">
          <div>
            <h3>Material already grouped</h3>
            <p>Keep its existing groups or move it only to this group?</p>
            <button onClick={() => void setMembership("copy")}>
              Copy membership
            </button>
            <button onClick={() => void setMembership("move")}>
              Move membership
            </button>
            <button onClick={() => setMembershipChoice(null)}>Cancel</button>
          </div>
        </div>
      )}
      {previewCheckpoint && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewId(null)}
        >
          <button className="lightbox-close" onClick={() => setPreviewId(null)}>
            <X />
          </button>
          <button
            className="lightbox-nav previous"
            disabled={previewIndex <= 0}
            onClick={(event) => {
              event.stopPropagation();
              setPreviewId(workspace!.checkpoints[previewIndex - 1].id);
            }}
          >
            <ChevronLeft />
          </button>
          <div
            className="lightbox-content"
            onClick={(event) => event.stopPropagation()}
          >
            <img src={fileUrl(previewCheckpoint.storage_path)} />
            <div>
              <span>
                {previewIndex + 1} / {workspace!.checkpoints.length}
              </span>
              <p>{previewCheckpoint.prompt_text}</p>
              <a href={`/api/checkpoints/${previewCheckpoint.id}/download`}>
                <Download size={15} /> Download
              </a>
            </div>
          </div>
          <button
            className="lightbox-nav next"
            disabled={previewIndex >= workspace!.checkpoints.length - 1}
            onClick={(event) => {
              event.stopPropagation();
              setPreviewId(workspace!.checkpoints[previewIndex + 1].id);
            }}
          >
            <ChevronRight />
          </button>
        </div>
      )}
      {previewMaterial && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${previewMaterial.label}`}
          onClick={() => setMaterialPreviewId(null)}
        >
          <button
            className="lightbox-close"
            aria-label="Close preview"
            onClick={() => setMaterialPreviewId(null)}
          >
            <X />
          </button>
          <button
            className="lightbox-nav previous"
            disabled={materialPreviewIndex <= 0}
            onClick={(event) => {
              event.stopPropagation();
              setMaterialPreviewId(
                workspace!.materials[materialPreviewIndex - 1].id,
              );
            }}
          >
            <ChevronLeft />
          </button>
          <div
            className="lightbox-content"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={fileUrl(previewMaterial.storage_path)}
              alt={previewMaterial.label}
            />
            <div>
              <span>
                {materialPreviewIndex + 1} / {workspace!.materials.length}
              </span>
              <p>
                {previewMaterial.label} · {previewMaterial.width} ×{" "}
                {previewMaterial.height}
              </p>
              <span>Uploaded material</span>
            </div>
          </div>
          <button
            className="lightbox-nav next"
            disabled={materialPreviewIndex >= workspace!.materials.length - 1}
            onClick={(event) => {
              event.stopPropagation();
              setMaterialPreviewId(
                workspace!.materials[materialPreviewIndex + 1].id,
              );
            }}
          >
            <ChevronRight />
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
