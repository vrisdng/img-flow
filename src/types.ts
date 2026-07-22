export type JobStatus =
  "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";
export type ImageSettings = {
  size: "1024x1024" | "1024x1536" | "1536x1024";
  quality: "low" | "medium" | "high";
  background: "auto" | "opaque" | "transparent";
  outputFormat: "png" | "jpeg" | "webp";
};
export type JobSnapshot = {
  prompt: string;
  promptVersionId: string;
  parentCheckpointId: string | null;
  materialIds: string[];
  settings: ImageSettings;
  model: string;
  variationIndex: number;
  generationNodeId?: string | null;
  groupSnapshots?: GroupSnapshot[];
};
export type GroupSnapshot = {
  id: string;
  label: string;
  notes?: string;
  path: string[];
  materialIds: string[];
};
export type ApiEvent = {
  id: number;
  type: string;
  projectId: string | null;
  payload: unknown;
  createdAt: string;
};
