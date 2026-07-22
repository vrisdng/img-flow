import express from "express";
import cors from "cors";
import multer from "multer";
import archiver from "archiver";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { emit, id, must, now, supabase } from "./db.js";
import { downloadStored, inspectImage, storeMaterial } from "./storage.js";
import type { ImageSettings, JobSnapshot } from "./types.js";
import { resolveGroups, wouldCreateCycle } from "./group-resolver.js";
const app = express();
app.use(cors({ origin: ["http://127.0.0.1:5173", "http://localhost:5173"] }));
app.use(express.json({ limit: "1mb" }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
});
const unwrap = (r: any): any => {
  if (r.error) throw new Error(r.error.message);
  return r.data;
};
async function resolveProjectGroups(projectId: string, rootIds: string[]) {
  const [
    { data: groups },
    { data: members },
    { data: nodes },
    { data: edges },
  ] = await Promise.all([
    supabase
      .from("material_groups")
      .select("id,label")
      .eq("project_id", projectId),
    supabase
      .from("material_group_members")
      .select("*")
      .in(
        "group_id",
        rootIds.length
          ? ((
              await supabase
                .from("material_groups")
                .select("id")
                .eq("project_id", projectId)
            ).data?.map((g: any) => g.id) ?? [])
          : [],
      ),
    supabase
      .from("canvas_nodes")
      .select("id,entity_id,config_json")
      .eq("project_id", projectId)
      .eq("node_type", "group"),
    supabase
      .from("canvas_edges")
      .select("*")
      .eq("project_id", projectId)
      .eq("edge_type", "group_include"),
  ]);
  const nodeGroup = new Map((nodes ?? []).map((n: any) => [n.id, n.entity_id]));
  const notesByGroup = new Map(
    (nodes ?? []).map((n: any) => [n.entity_id, n.config_json?.notes ?? ""]),
  );
  return resolveGroups(
    rootIds,
    (groups ?? []).map((group: any) => ({
      ...group,
      notes: notesByGroup.get(group.id) ?? "",
    })),
    members ?? [],
    (edges ?? []).map((e: any) => ({
      source_group_id: nodeGroup.get(e.source_node_id),
      target_group_id: nodeGroup.get(e.target_node_id),
      position: e.position,
    })),
    15,
  );
}
app.get("/api/health", async (_q, res, next) => {
  try {
    const { error } = await supabase
      .from("projects")
      .select("id", { head: true, count: "exact" });
    res.json({
      ok: !error,
      database: "supabase",
      storage: "supabase",
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
    });
  } catch (e) {
    next(e);
  }
});
app.get("/api/projects", async (_q, res, next) => {
  try {
    res.json(
      unwrap(
        await supabase
          .from("projects")
          .select("*")
          .is("archived_at", null)
          .order("updated_at", { ascending: false }),
      ),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/projects", async (req, res, next) => {
  try {
    const name = z.string().trim().min(1).max(80).parse(req.body.name);
    const project = unwrap(
      await supabase
        .from("projects")
        .insert({ id: id(), name })
        .select()
        .single(),
    );
    await emit("project.created", project.id, { projectId: project.id });
    res.status(201).json(project);
  } catch (e) {
    next(e);
  }
});
app.patch("/api/projects/:id", async (req, res, next) => {
  try {
    const values: {
      name?: string;
      archived_at?: string | null;
      updated_at: string;
    } = { updated_at: now() };
    if (req.body.name !== undefined)
      values.name = z.string().trim().min(1).max(80).parse(req.body.name);
    if (req.body.archived !== undefined)
      values.archived_at = req.body.archived ? now() : null;
    const project = unwrap(
      await supabase
        .from("projects")
        .update(values)
        .eq("id", req.params.id)
        .select()
        .maybeSingle(),
    );
    if (!project) return res.sendStatus(404);
    await emit("project.updated", project.id, { projectId: project.id });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
app.get("/api/projects/:id/workspace", async (req, res, next) => {
  try {
    const [pr, ma, pv, cp, jo, gr, gm, cn, ce] = await Promise.all([
      supabase
        .from("projects")
        .select("*")
        .eq("id", req.params.id)
        .maybeSingle(),
      supabase
        .from("materials")
        .select("*")
        .eq("project_id", req.params.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("prompt_versions")
        .select("*")
        .eq("project_id", req.params.id)
        .order("created_at"),
      supabase
        .from("checkpoints")
        .select("*,prompt_versions(text)")
        .eq("project_id", req.params.id)
        .order("created_at"),
      supabase
        .from("jobs")
        .select("*")
        .eq("project_id", req.params.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("material_groups")
        .select("*")
        .eq("project_id", req.params.id)
        .order("created_at"),
      supabase
        .from("material_group_members")
        .select("*")
        .in(
          "group_id",
          (
            await supabase
              .from("material_groups")
              .select("id")
              .eq("project_id", req.params.id)
          ).data?.map((g: any) => g.id) ?? [],
        )
        .order("position"),
      supabase.from("canvas_nodes").select("*").eq("project_id", req.params.id),
      supabase
        .from("canvas_edges")
        .select("*")
        .eq("project_id", req.params.id)
        .order("position"),
    ]);
    if (pr.error || !pr.data) return res.sendStatus(404);
    res.json({
      project: pr.data,
      materials: unwrap(ma),
      prompts: unwrap(pv),
      checkpoints: unwrap(cp).map((c: any) => ({
        ...c,
        prompt_text: c.prompt_versions?.text,
        prompt_versions: undefined,
      })),
      jobs: unwrap(jo).map((j: any) => ({
        ...j,
        snapshot: j.snapshot_json,
        snapshot_json: undefined,
      })),
      groups: unwrap(gr).map((group: any) => ({
        ...group,
        notes:
          unwrap(cn).find(
            (node: any) =>
              node.node_type === "group" && node.entity_id === group.id,
          )?.config_json?.notes ?? "",
      })),
      groupMembers: unwrap(gm),
      canvasNodes: unwrap(cn),
      canvasEdges: unwrap(ce),
    });
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/projects/:id/materials",
  upload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Choose an image." });
      const meta = await inspectImage(req.file.buffer);
      const { data: existing } = await supabase
        .from("materials")
        .select("*")
        .eq("project_id", req.params.id)
        .eq("sha256", meta.hash)
        .maybeSingle();
      if (existing) return res.json(existing);
      const ext =
        meta.mime === "image/png"
          ? "png"
          : meta.mime === "image/jpeg"
            ? "jpg"
            : "webp";
      const storage_path = await storeMaterial(req.file.buffer, ext, meta.mime);
      const material = unwrap(
        await supabase
          .from("materials")
          .insert({
            id: id(),
            project_id: req.params.id,
            label: String(req.body.label || req.file.originalname).slice(
              0,
              100,
            ),
            sha256: meta.hash,
            mime_type: meta.mime,
            width: meta.width,
            height: meta.height,
            size_bytes: meta.size,
            storage_path,
          })
          .select()
          .single(),
      );
      await emit("material.created", req.params.id, {
        materialId: material.id,
      });
      res.status(201).json(material);
    } catch (e) {
      next(e);
    }
  },
);
app.delete("/api/materials/:id", async (req, res, next) => {
  try {
    const { data: material } = await supabase
      .from("materials")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!material) return res.sendStatus(404);
    const { data: used } = await supabase
      .from("job_materials")
      .select("job_id")
      .eq("material_id", req.params.id)
      .limit(1);
    if (used?.length)
      return res.status(409).json({
        error:
          "This material is part of immutable job history and cannot be deleted.",
      });
    unwrap(
      await supabase
        .from("materials")
        .delete()
        .eq("id", req.params.id)
        .select(),
    );
    await supabase.storage.from("image-flow").remove([material.storage_path]);
    await emit("material.deleted", material.project_id, {
      materialId: req.params.id,
    });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
app.post("/api/projects/:id/groups", async (req, res, next) => {
  try {
    const label = z.string().trim().min(1).max(80).parse(req.body.label);
    const groupId = id(),
      nodeId = id();
    const group = unwrap(
      await supabase
        .from("material_groups")
        .insert({
          id: groupId,
          project_id: req.params.id,
          label,
          color: req.body.color ?? "#8b8b92",
        })
        .select()
        .single(),
    );
    await supabase.from("canvas_nodes").insert({
      id: nodeId,
      project_id: req.params.id,
      node_type: "group",
      entity_id: groupId,
      position_x: Number(req.body.x ?? 100),
      position_y: Number(req.body.y ?? 100),
    });
    await emit("graph.updated", req.params.id, { kind: "group.created" });
    res.status(201).json({ ...group, nodeId });
  } catch (e) {
    next(e);
  }
});
app.patch("/api/groups/:id", async (req, res, next) => {
  try {
    const values: any = { updated_at: now() };
    if (req.body.label !== undefined)
      values.label = z.string().trim().min(1).max(80).parse(req.body.label);
    if (req.body.color !== undefined)
      values.color = z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .parse(req.body.color);
    if (req.body.notes !== undefined) {
      const notes = z.string().max(4000).parse(req.body.notes);
      const { data: groupNode } = await supabase
        .from("canvas_nodes")
        .select("id,config_json")
        .eq("node_type", "group")
        .eq("entity_id", req.params.id)
        .maybeSingle();
      if (groupNode)
        unwrap(
          await supabase
            .from("canvas_nodes")
            .update({
              config_json: { ...(groupNode.config_json ?? {}), notes },
              updated_at: now(),
            })
            .eq("id", groupNode.id),
        );
    }
    const data = unwrap(
      await supabase
        .from("material_groups")
        .update(values)
        .eq("id", req.params.id)
        .select()
        .single(),
    );
    await emit("graph.updated", data.project_id, { kind: "group.updated" });
    res.json(data);
  } catch (e) {
    next(e);
  }
});
app.post("/api/groups/:id/members", async (req, res, next) => {
  try {
    const input = z
      .object({
        materialId: z.string().uuid(),
        mode: z.enum(["copy", "move"]).default("copy"),
      })
      .parse(req.body);
    const { data: group } = await supabase
      .from("material_groups")
      .select("project_id")
      .eq("id", req.params.id)
      .single();
    const { data: material } = await supabase
      .from("materials")
      .select("project_id")
      .eq("id", input.materialId)
      .single();
    if (!group || !material || group.project_id !== material.project_id)
      return res
        .status(400)
        .json({ error: "Group and material must belong to the same project." });
    if (input.mode === "move")
      await supabase
        .from("material_group_members")
        .delete()
        .eq("material_id", input.materialId);
    const { data: last } = await supabase
      .from("material_group_members")
      .select("position")
      .eq("group_id", req.params.id)
      .order("position", { ascending: false })
      .limit(1);
    await supabase.from("material_group_members").upsert({
      group_id: req.params.id,
      material_id: input.materialId,
      position: (last?.[0]?.position ?? -1) + 1,
    });
    await emit("graph.updated", group.project_id, {
      kind: "membership.updated",
    });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
app.delete(
  "/api/groups/:groupId/members/:materialId",
  async (req, res, next) => {
    try {
      const { data: g } = await supabase
        .from("material_groups")
        .select("project_id")
        .eq("id", req.params.groupId)
        .single();
      await supabase
        .from("material_group_members")
        .delete()
        .eq("group_id", req.params.groupId)
        .eq("material_id", req.params.materialId);
      if (g)
        await emit("graph.updated", g.project_id, {
          kind: "membership.deleted",
        });
      res.sendStatus(204);
    } catch (e) {
      next(e);
    }
  },
);
app.post("/api/projects/:id/canvas/nodes", async (req, res, next) => {
  try {
    const input = z
      .object({
        nodeType: z.enum(["material", "generation", "checkpoint"]),
        entityId: z.string().uuid().nullable().optional(),
        x: z.number(),
        y: z.number(),
        config: z.record(z.any()).default({}),
      })
      .parse(req.body);
    const node = unwrap(
      await supabase
        .from("canvas_nodes")
        .insert({
          id: id(),
          project_id: req.params.id,
          node_type: input.nodeType,
          entity_id: input.entityId ?? null,
          position_x: input.x,
          position_y: input.y,
          config_json: input.config,
        })
        .select()
        .single(),
    );
    await emit("graph.updated", req.params.id, { kind: "node.created" });
    res.status(201).json(node);
  } catch (e) {
    next(e);
  }
});
app.patch("/api/canvas/nodes/:id", async (req, res, next) => {
  try {
    const values: any = { updated_at: now() };
    if (req.body.x !== undefined) values.position_x = Number(req.body.x);
    if (req.body.y !== undefined) values.position_y = Number(req.body.y);
    if (req.body.config !== undefined) values.config_json = req.body.config;
    const node = unwrap(
      await supabase
        .from("canvas_nodes")
        .update(values)
        .eq("id", req.params.id)
        .select()
        .single(),
    );
    await emit("graph.updated", node.project_id, { kind: "node.updated" });
    res.json(node);
  } catch (e) {
    next(e);
  }
});
app.delete("/api/canvas/nodes/:id", async (req, res, next) => {
  try {
    const { data: n } = await supabase
      .from("canvas_nodes")
      .select("project_id,node_type,entity_id")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!n) return res.status(404).json({ error: "Canvas node not found." });
    unwrap(
      await supabase.from("canvas_nodes").delete().eq("id", req.params.id),
    );
    if (n?.node_type === "group")
      await supabase.from("material_groups").delete().eq("id", n.entity_id);
    if (n) await emit("graph.updated", n.project_id, { kind: "node.deleted" });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
app.post("/api/projects/:id/canvas/edges", async (req, res, next) => {
  try {
    const input = z
      .object({
        source: z.string().uuid(),
        target: z.string().uuid(),
        sourcePosition: z.object({ x: z.number(), y: z.number() }).optional(),
        targetPosition: z.object({ x: z.number(), y: z.number() }).optional(),
      })
      .parse(req.body);
    // Older checkpoints predate canvas_nodes and are rendered with their
    // checkpoint ID. Materialize the graph node on first connection.
    const normalizeEndpoint = async (
      endpointId: string,
      position?: { x: number; y: number },
    ) => {
      const { data: existing } = await supabase
        .from("canvas_nodes")
        .select("id")
        .eq("id", endpointId)
        .eq("project_id", req.params.id)
        .maybeSingle();
      if (existing) return existing.id;
      const { data: checkpoint } = await supabase
        .from("checkpoints")
        .select("id")
        .eq("id", endpointId)
        .eq("project_id", req.params.id)
        .maybeSingle();
      if (!checkpoint) return endpointId;
      const node = unwrap(
        await supabase
          .from("canvas_nodes")
          .insert({
            id: id(),
            project_id: req.params.id,
            node_type: "checkpoint",
            entity_id: checkpoint.id,
            position_x: position?.x ?? 0,
            position_y: position?.y ?? 0,
            config_json: {},
          })
          .select("id")
          .single(),
      );
      return node.id;
    };
    const sourceId = await normalizeEndpoint(
      input.source,
      input.sourcePosition,
    );
    const targetId = await normalizeEndpoint(
      input.target,
      input.targetPosition,
    );
    const { data: nodes } = await supabase
      .from("canvas_nodes")
      .select("*")
      .eq("project_id", req.params.id)
      .in("id", [sourceId, targetId]);
    if (nodes?.length !== 2)
      return res
        .status(400)
        .json({ error: "Both nodes must belong to this project." });
    const source = nodes.find((n: any) => n.id === sourceId),
      target = nodes.find((n: any) => n.id === targetId);
    let edgeType: string;
    if (source.node_type === "group" && target.node_type === "group") {
      edgeType = "group_include";
      const { data: all } = await supabase
        .from("canvas_edges")
        .select("source_node_id,target_node_id")
        .eq("project_id", req.params.id)
        .eq("edge_type", "group_include");
      const nodeGroup = new Map(nodes.map((n: any) => [n.id, n.entity_id]));
      const { data: groupNodes } = await supabase
        .from("canvas_nodes")
        .select("id,entity_id")
        .eq("project_id", req.params.id)
        .eq("node_type", "group");
      for (const n of groupNodes ?? []) nodeGroup.set(n.id, n.entity_id);
      const groupEdges = (all ?? []).map((e: any) => ({
        source_group_id: nodeGroup.get(e.source_node_id),
        target_group_id: nodeGroup.get(e.target_node_id),
        position: 0,
      }));
      if (wouldCreateCycle(groupEdges, source.entity_id, target.entity_id))
        return res
          .status(409)
          .json({ error: "This link would create a group cycle." });
    } else if (
      source.node_type === "group" &&
      target.node_type === "generation"
    )
      edgeType = "group_input";
    else if (
      source.node_type === "checkpoint" &&
      target.node_type === "generation"
    )
      edgeType = "checkpoint_input";
    else
      return res.status(400).json({
        error:
          "Unsupported connection. Connect groups to groups/generations or checkpoints to generations.",
      });
    const { data: last } = await supabase
      .from("canvas_edges")
      .select("position")
      .eq("target_node_id", targetId)
      .order("position", { ascending: false })
      .limit(1);
    const edge = unwrap(
      await supabase
        .from("canvas_edges")
        .insert({
          id: id(),
          project_id: req.params.id,
          source_node_id: sourceId,
          target_node_id: targetId,
          edge_type: edgeType,
          position: (last?.[0]?.position ?? -1) + 1,
        })
        .select()
        .single(),
    );
    await emit("graph.updated", req.params.id, { kind: "edge.created" });
    res.status(201).json(edge);
  } catch (e) {
    next(e);
  }
});
app.delete("/api/canvas/edges/:id", async (req, res, next) => {
  try {
    const { data: e } = await supabase
      .from("canvas_edges")
      .delete()
      .eq("id", req.params.id)
      .select()
      .single();
    if (e) await emit("graph.updated", e.project_id, { kind: "edge.deleted" });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
const jobSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  parentCheckpointId: z.string().uuid().nullable().optional(),
  parentPromptVersionId: z.string().uuid().nullable().optional(),
  materialIds: z.array(z.string().uuid()).max(15).default([]),
  variations: z.number().int().min(1).max(4).default(1),
  idempotencyKey: z.string().min(8).max(200),
  generationNodeId: z.string().uuid().nullable().optional(),
  groupSnapshots: z.array(z.any()).default([]),
  groupIds: z.array(z.string().uuid()).default([]),
  settings: z.object({
    size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1024"),
    quality: z.enum(["low", "medium", "high"]).default("medium"),
    background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
    outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  }),
});
app.post("/api/projects/:id/jobs", async (req, res, next) => {
  try {
    const input = jobSchema.parse(req.body);
    if (input.groupIds.length) {
      const resolved = await resolveProjectGroups(
        req.params.id,
        input.groupIds,
      );
      input.materialIds = [
        ...new Set([...resolved.materialIds, ...input.materialIds]),
      ];
      if (input.materialIds.length > 15)
        return res.status(400).json({
          error: `Quick inputs resolve to ${input.materialIds.length} materials; maximum is 15.`,
        });
      input.groupSnapshots = resolved.groupSnapshots;
    }
    const { data: existing } = await supabase
      .from("jobs")
      .select("*")
      .like("idempotency_key", `${input.idempotencyKey}:%`)
      .order("created_at");
    if (existing?.length)
      return res.json(
        existing.map((j: any) => ({
          ...j,
          snapshot: j.snapshot_json,
          snapshot_json: undefined,
        })),
      );
    if (input.parentCheckpointId) {
      const { data } = await supabase
        .from("checkpoints")
        .select("id")
        .eq("id", input.parentCheckpointId)
        .eq("project_id", req.params.id)
        .maybeSingle();
      if (!data)
        return res.status(400).json({
          error: "Parent checkpoint does not belong to this project.",
        });
    }
    if (input.materialIds.length) {
      const { data } = await supabase
        .from("materials")
        .select("id")
        .eq("project_id", req.params.id)
        .in("id", input.materialIds);
      if (data?.length !== input.materialIds.length)
        return res.status(400).json({
          error: "A selected material does not belong to this project.",
        });
    }
    const promptId = id(),
      branchId = id();
    unwrap(
      await supabase
        .from("prompt_versions")
        .insert({
          id: promptId,
          project_id: req.params.id,
          parent_prompt_version_id: input.parentPromptVersionId ?? null,
          text: input.prompt,
        })
        .select(),
    );
    unwrap(
      await supabase
        .from("branches")
        .insert({
          id: branchId,
          project_id: req.params.id,
          root_checkpoint_id: input.parentCheckpointId ?? null,
        })
        .select(),
    );
    const jobs = Array.from(
      { length: input.variations },
      (_, variationIndex) => {
        const snapshot: JobSnapshot = {
          prompt: input.prompt,
          promptVersionId: promptId,
          parentCheckpointId: input.parentCheckpointId ?? null,
          materialIds: input.materialIds,
          settings: input.settings as ImageSettings,
          model: config.model,
          variationIndex,
          groupSnapshots: input.groupSnapshots,
          generationNodeId: input.generationNodeId ?? null,
        };
        return {
          id: id(),
          project_id: req.params.id,
          branch_id: branchId,
          status: "queued",
          stage: "Queued",
          progress: 5,
          snapshot_json: snapshot,
          idempotency_key: `${input.idempotencyKey}:${variationIndex}`,
        };
      },
    );
    const created = unwrap(await supabase.from("jobs").insert(jobs).select());
    const links = created.flatMap((job) =>
      input.materialIds.map((material_id, position) => ({
        job_id: job.id,
        material_id,
        position,
      })),
    );
    if (links.length)
      unwrap(await supabase.from("job_materials").insert(links).select());
    await Promise.all(
      created.map((job) =>
        emit("job.queued", req.params.id, { jobId: job.id }),
      ),
    );
    await supabase
      .from("projects")
      .update({ updated_at: now() })
      .eq("id", req.params.id);
    res.status(202).json(
      created.map((j: any) => ({
        ...j,
        snapshot: j.snapshot_json,
        snapshot_json: undefined,
      })),
    );
  } catch (e) {
    next(e);
  }
});
app.post(
  "/api/projects/:projectId/generation-nodes/:nodeId/run",
  async (req, res, next) => {
    try {
      const { projectId, nodeId } = req.params;
      const [
        { data: node },
        { data: nodes },
        { data: edges },
        { data: groups },
        { data: members },
      ] = await Promise.all([
        supabase
          .from("canvas_nodes")
          .select("*")
          .eq("id", nodeId)
          .eq("project_id", projectId)
          .eq("node_type", "generation")
          .single(),
        supabase.from("canvas_nodes").select("*").eq("project_id", projectId),
        supabase
          .from("canvas_edges")
          .select("*")
          .eq("project_id", projectId)
          .order("position"),
        supabase
          .from("material_groups")
          .select("id,label")
          .eq("project_id", projectId),
        supabase
          .from("material_group_members")
          .select("*")
          .in(
            "group_id",
            (
              await supabase
                .from("material_groups")
                .select("id")
                .eq("project_id", projectId)
            ).data?.map((g: any) => g.id) ?? [],
          ),
      ]);
      if (!node) return res.sendStatus(404);
      const byNode = new Map<string, any>(
        (nodes ?? []).map((n: any) => [n.id, n]),
      );
      const inbound = (edges ?? []).filter(
        (e: any) => e.target_node_id === nodeId,
      );
      const rootIds = inbound
        .filter((e: any) => e.edge_type === "group_input")
        .map((e: any) => byNode.get(e.source_node_id)?.entity_id)
        .filter(Boolean);
      const groupEdges = (edges ?? [])
        .filter((e: any) => e.edge_type === "group_include")
        .map((e: any) => ({
          source_group_id: byNode.get(e.source_node_id)?.entity_id,
          target_group_id: byNode.get(e.target_node_id)?.entity_id,
          position: e.position,
        }));
      const resolved = resolveGroups(
        rootIds,
        (groups ?? []).map((group: any) => ({
          ...group,
          notes:
            (nodes ?? []).find(
              (candidate: any) =>
                candidate.node_type === "group" &&
                candidate.entity_id === group.id,
            )?.config_json?.notes ?? "",
        })),
        members ?? [],
        groupEdges,
        15,
      );
      const bases = inbound.filter(
        (e: any) => e.edge_type === "checkpoint_input",
      );
      if (bases.length > 1)
        return res.status(400).json({
          error: "A generation node can have only one base checkpoint.",
        });
      const parentCheckpointId = bases[0]
        ? byNode.get(bases[0].source_node_id)?.entity_id
        : null;
      const configJson = node.config_json ?? {};
      const prompt = z
        .string()
        .trim()
        .min(1)
        .max(32000)
        .parse(configJson.prompt);
      const body = {
        prompt,
        parentCheckpointId,
        materialIds: resolved.materialIds,
        variations: Number(configJson.variations ?? 1),
        idempotencyKey: crypto.randomUUID(),
        settings: configJson.settings ?? {
          size: "1024x1024",
          quality: "medium",
          background: "auto",
          outputFormat: "png",
        },
        generationNodeId: nodeId,
        groupSnapshots: resolved.groupSnapshots,
      };
      const response = await fetch(
        `http://${config.host}:${config.port}/api/projects/${projectId}/jobs`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      res.status(response.status).json(result);
    } catch (e) {
      next(e);
    }
  },
);
app.post("/api/jobs/:id/cancel", async (req, res, next) => {
  try {
    const { data: job } = await supabase
      .from("jobs")
      .select("project_id,status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!job) return res.sendStatus(404);
    const values: any = {
      cancel_requested: true,
      stage: "Cancelling",
      updated_at: now(),
    };
    if (["queued", "retrying"].includes(job.status)) {
      values.status = "cancelled";
      values.stage = "Cancelled";
    }
    await supabase
      .from("jobs")
      .update(values)
      .eq("id", req.params.id)
      .not("status", "in", "(completed,failed,cancelled)");
    await emit("job.cancelled", job.project_id, { jobId: req.params.id });
    res.sendStatus(204);
  } catch (e) {
    next(e);
  }
});
app.post("/api/jobs/:id/retry", async (req, res, next) => {
  try {
    const { data: job } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", req.params.id)
      .eq("status", "failed")
      .maybeSingle();
    if (!job)
      return res
        .status(409)
        .json({ error: "Only failed jobs can be retried." });
    unwrap(
      await supabase
        .from("jobs")
        .update({
          status: "queued",
          stage: "Queued for manual retry",
          progress: 5,
          attempt_count: 0,
          next_attempt_at: now(),
          error_category: null,
          error_message: null,
          cancel_requested: false,
          updated_at: now(),
        })
        .eq("id", req.params.id)
        .select(),
    );
    await emit("job.queued", job.project_id, {
      jobId: req.params.id,
      manualRetry: true,
    });
    res.sendStatus(202);
  } catch (e) {
    next(e);
  }
});
async function sendStorage(
  res: express.Response,
  storagePath: string,
  mime: string,
  name?: string,
) {
  const buffer = await downloadStored(storagePath);
  res.set("Cache-Control", "private, max-age=3600, immutable");
  res.type(mime);
  if (name) res.attachment(name);
  res.send(buffer);
}
app.get("/api/files/:kind/:name", async (req, res, next) => {
  try {
    const storagePath = `${req.params.kind}/${req.params.name}`;
    const mime =
      path.extname(req.params.name) === ".png"
        ? "image/png"
        : path.extname(req.params.name) === ".webp"
          ? "image/webp"
          : "image/jpeg";
    await sendStorage(res, storagePath, mime);
  } catch (e) {
    next(e);
  }
});
app.get("/api/checkpoints/:id/download", async (req, res, next) => {
  try {
    const { data: cp } = await supabase
      .from("checkpoints")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!cp) return res.sendStatus(404);
    await sendStorage(
      res,
      cp.storage_path,
      cp.mime_type,
      `image-flow-${cp.id}${path.extname(cp.storage_path)}`,
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/checkpoints/download", async (req, res, next) => {
  try {
    const ids = z.array(z.string().uuid()).min(1).max(100).parse(req.body.ids);
    const { data, error } = await supabase
      .from("checkpoints")
      .select("*")
      .in("id", ids);
    if (error) throw error;
    if (data.length !== ids.length)
      return res
        .status(404)
        .json({ error: "One or more checkpoints were not found." });
    res.attachment("image-flow-selection.zip");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (e) => res.destroy(e));
    archive.pipe(res);
    for (const [i, cp] of data.entries())
      archive.append(await downloadStored(cp.storage_path), {
        name: `${i + 1}-${cp.id}${path.extname(cp.storage_path)}`,
      });
    void archive.finalize();
  } catch (e) {
    next(e);
  }
});
app.get("/api/events", async (req, res) => {
  const projectId =
    typeof req.query.projectId === "string" ? req.query.projectId : null;
  let cursor = Number(req.header("Last-Event-ID") ?? req.query.after ?? 0),
    busy = false;
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  const send = async () => {
    if (busy) return;
    busy = true;
    let query = supabase
      .from("events")
      .select("*")
      .gt("id", cursor)
      .order("id")
      .limit(100);
    if (projectId)
      query = query.or(`project_id.eq.${projectId},project_id.is.null`);
    const { data } = await query;
    for (const event of data ?? []) {
      cursor = Number(event.id);
      res.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload_json)}\n\n`,
      );
    }
    busy = false;
  };
  await send();
  const timer = setInterval(() => {
    void send();
    res.write(": heartbeat\n\n");
  }, 1000);
  req.on("close", () => clearInterval(timer));
});
const webBuild = path.resolve("dist-web");
if (fs.existsSync(webBuild)) {
  app.use(express.static(webBuild));
  app.use((req, res, next) =>
    req.method === "GET" && req.accepts("html")
      ? res.sendFile(path.join(webBuild, "index.html"))
      : next(),
  );
}
app.use(
  (
    error: unknown,
    _q: express.Request,
    res: express.Response,
    _n: express.NextFunction,
  ) => {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message
        : error instanceof Error
          ? error.message
          : "Unexpected error";
    res
      .status(error instanceof z.ZodError ? 400 : 500)
      .json({ error: message });
  },
);
app.listen(config.port, config.host, () =>
  console.log(`Image Flow API http://${config.host}:${config.port} · Supabase`),
);
