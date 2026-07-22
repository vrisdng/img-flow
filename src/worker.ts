import os from "node:os";
import OpenAI, { toFile } from "openai";
import { config } from "./config.js";
import { emit, id, now, supabase } from "./db.js";
import { downloadStored, inspectImage, storeOutputAtomic } from "./storage.js";
import {
  cancellationRequested,
  finishAttempt,
  leaseNext,
  recoverExpiredLeases,
  renewLease,
  updateProgress,
  type LeasedJob,
} from "./queue.js";
import { classifyError, retryDelay } from "./errors.js";
import { buildImagePrompt } from "./image-prompt.js";
const owner = `${os.hostname()}:${process.pid}`;
const client = config.apiKey
  ? new OpenAI({ apiKey: config.apiKey, timeout: 180000, maxRetries: 0 })
  : null;
await recoverExpiredLeases();
async function generate(
  job: LeasedJob,
  signal: AbortSignal,
  onGenerating: (stage: string) => void,
) {
  if (!client)
    throw Object.assign(new Error("OPENAI_API_KEY is not configured."), {
      status: 401,
    });
  const s = job.snapshot,
    x = s.settings;
  const inputs: { storage_path: string; mime_type: string }[] = [];
  const materialLabels: string[] = [];
  if (s.parentCheckpointId) {
    const { data } = await supabase
      .from("checkpoints")
      .select("storage_path,mime_type")
      .eq("id", s.parentCheckpointId)
      .single();
    if (data) inputs.push(data);
  }
  if (s.materialIds.length) {
    const { data, error } = await supabase
      .from("materials")
      .select("id,label,storage_path,mime_type")
      .in("id", s.materialIds);
    if (error) throw error;
    for (const materialId of s.materialIds) {
      const material = data?.find((m) => m.id === materialId);
      if (material) {
        inputs.push(material);
        materialLabels.push(material.label);
      }
    }
  }
  const groupedPrompt = s.groupSnapshots?.length
    ? `GROUPS USED\n${s.groupSnapshots.map((group) => `- ${group.path.join(" > ")}: ${group.materialIds.length} material(s)${group.notes ? `\n  Notes: ${group.notes}` : ""}`).join("\n")}\n\nUSER INSTRUCTIONS\n${s.prompt}`
    : s.prompt;
  const effectivePrompt = buildImagePrompt(
    groupedPrompt,
    Boolean(s.parentCheckpointId),
    materialLabels,
  );
  await updateProgress(
    job.id,
    job.project_id,
    inputs.length ? "Preparing numbered source images" : "Preparing prompt",
    15,
  );
  let response;
  if (inputs.length) {
    const images = await Promise.all(
      inputs.map(async (item, index) => {
        const buffer = await downloadStored(item.storage_path);
        const ext =
          item.mime_type === "image/jpeg"
            ? ".jpg"
            : item.mime_type === "image/webp"
              ? ".webp"
              : ".png";
        return toFile(buffer, `input-${index}${ext}`, { type: item.mime_type });
      }),
    );
    const stage = "Generating edit with OpenAI · estimated";
    onGenerating(stage);
    await updateProgress(job.id, job.project_id, stage, 25);
    response = await client.images.edit(
      {
        model: s.model,
        prompt: effectivePrompt,
        image: images,
        size: x.size,
        quality: x.quality,
        background: x.background,
        output_format: x.outputFormat,
      },
      { signal },
    );
  } else {
    const stage = "Generating with OpenAI · estimated";
    onGenerating(stage);
    await updateProgress(job.id, job.project_id, stage, 25);
    response = await client.images.generate(
      {
        model: s.model,
        prompt: effectivePrompt,
        size: x.size,
        quality: x.quality,
        background: x.background,
        output_format: x.outputFormat,
      },
      { signal },
    );
  }
  const encoded = response.data?.[0]?.b64_json;
  if (!encoded)
    throw Object.assign(new Error("OpenAI returned no image data."), {
      status: 502,
    });
  return {
    buffer: Buffer.from(encoded, "base64"),
    requestId: response._request_id ?? undefined,
  };
}
async function processJob(job: LeasedJob) {
  const controller = new AbortController();
  let generationStage = "",
    generationStarted = 0,
    lastEstimate = 25,
    watchBusy = false;
  const watcher = setInterval(async () => {
    if (watchBusy) return;
    watchBusy = true;
    try {
      await renewLease(job.id, owner);
      if (await cancellationRequested(job.id)) controller.abort();
      if (generationStage) {
        const estimate = Math.min(
          75,
          25 + Math.floor((Date.now() - generationStarted) / 1800),
        );
        if (estimate >= lastEstimate + 2) {
          lastEstimate = estimate;
          await updateProgress(
            job.id,
            job.project_id,
            generationStage,
            estimate,
          );
        }
      }
    } finally {
      watchBusy = false;
    }
  }, 1000);
  try {
    const result = await generate(job, controller.signal, (stage) => {
      generationStage = stage;
      generationStarted = Date.now();
    });
    generationStage = "";
    if (await cancellationRequested(job.id)) {
      await finishAttempt(job.id, "cancelled");
      await supabase
        .from("jobs")
        .update({
          status: "cancelled",
          stage: "Cancelled",
          lease_owner: null,
          lease_expires_at: null,
          updated_at: now(),
        })
        .eq("id", job.id);
      return;
    }
    await updateProgress(job.id, job.project_id, "Validating image", 82);
    const meta = await inspectImage(result.buffer),
      ext =
        job.snapshot.settings.outputFormat === "jpeg"
          ? "jpg"
          : job.snapshot.settings.outputFormat;
    await updateProgress(
      job.id,
      job.project_id,
      "Storing image in Supabase",
      92,
    );
    const storagePath = await storeOutputAtomic(result.buffer, ext, meta.mime);
    await updateProgress(job.id, job.project_id, "Creating checkpoint", 97);
    const checkpointId = id();
    const { error } = await supabase.from("checkpoints").insert({
      id: checkpointId,
      project_id: job.project_id,
      branch_id: job.branch_id,
      parent_checkpoint_id: job.snapshot.parentCheckpointId,
      prompt_version_id: job.snapshot.promptVersionId,
      job_id: job.id,
      storage_path: storagePath,
      mime_type: meta.mime,
      sha256: meta.hash,
      width: meta.width,
      height: meta.height,
      size_bytes: meta.size,
    });
    if (error) throw error;
    if (job.snapshot.generationNodeId) {
      const { data: generationNode } = await supabase
        .from("canvas_nodes")
        .select("position_x,position_y")
        .eq("id", job.snapshot.generationNodeId)
        .single();
      const checkpointNodeId = id();
      await supabase.from("canvas_nodes").insert({
        id: checkpointNodeId,
        project_id: job.project_id,
        node_type: "checkpoint",
        entity_id: checkpointId,
        position_x: (generationNode?.position_x ?? 0) + 320,
        position_y:
          (generationNode?.position_y ?? 0) + job.snapshot.variationIndex * 220,
      });
      await supabase.from("canvas_edges").insert({
        id: id(),
        project_id: job.project_id,
        source_node_id: job.snapshot.generationNodeId,
        target_node_id: checkpointNodeId,
        edge_type: "generation_output",
        position: job.snapshot.variationIndex,
      });
    }
    await supabase
      .from("jobs")
      .update({
        status: "completed",
        stage: "Completed",
        progress: 100,
        lease_owner: null,
        lease_expires_at: null,
        openai_request_id: result.requestId ?? null,
        updated_at: now(),
      })
      .eq("id", job.id);
    await finishAttempt(job.id, "completed", { requestId: result.requestId });
    await emit("job.completed", job.project_id, {
      jobId: job.id,
      checkpointId,
    });
  } catch (error) {
    const failure = classifyError(error),
      cancelled =
        (await cancellationRequested(job.id)) ||
        failure.category === "cancelled";
    if (cancelled) {
      await finishAttempt(job.id, "cancelled");
      await supabase
        .from("jobs")
        .update({
          status: "cancelled",
          stage: "Cancelled",
          lease_owner: null,
          lease_expires_at: null,
          updated_at: now(),
        })
        .eq("id", job.id);
      await emit("job.cancelled", job.project_id, { jobId: job.id });
    } else if (failure.transient && job.attempt_count < job.max_attempts) {
      const next = new Date(
        Date.now() + retryDelay(job.attempt_count, failure.retryAfterMs),
      ).toISOString();
      await finishAttempt(job.id, "retrying", failure);
      await supabase
        .from("jobs")
        .update({
          status: "retrying",
          stage: "Waiting to retry",
          progress: 5,
          next_attempt_at: next,
          lease_owner: null,
          lease_expires_at: null,
          error_category: failure.category,
          error_message: failure.message,
          openai_request_id: failure.requestId ?? null,
          updated_at: now(),
        })
        .eq("id", job.id);
      await emit("job.retrying", job.project_id, {
        jobId: job.id,
        attempt: job.attempt_count,
        nextAttemptAt: next,
      });
    } else {
      await finishAttempt(job.id, "failed", failure);
      await supabase
        .from("jobs")
        .update({
          status: "failed",
          stage: "Failed",
          lease_owner: null,
          lease_expires_at: null,
          error_category: failure.category,
          error_message: failure.message,
          openai_request_id: failure.requestId ?? null,
          updated_at: now(),
        })
        .eq("id", job.id);
      await emit("job.failed", job.project_id, {
        jobId: job.id,
        category: failure.category,
      });
    }
  } finally {
    clearInterval(watcher);
  }
}
const active = new Set<Promise<void>>();
async function tick() {
  while (active.size < config.concurrency) {
    const job = await leaseNext(owner);
    if (!job) break;
    const promise = processJob(job).finally(() => active.delete(promise));
    active.add(promise);
  }
}
setInterval(() => void tick(), 500);
void tick();
console.log(
  `Image Flow worker ${owner}; concurrency ${config.concurrency} · Supabase`,
);
