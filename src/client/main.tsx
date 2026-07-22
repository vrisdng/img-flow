import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, Controls, Handle, Position, ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Archive, Check, Download, ImagePlus, LoaderCircle, Plus, RotateCcw, Sparkles, Square, Upload, X } from 'lucide-react';
import './styles.css';
import './progress.css';

type Project = { id: string; name: string };
type Material = { id: string; label: string; storage_path: string; width: number; height: number };
type Checkpoint = { id: string; parent_checkpoint_id: string | null; prompt_version_id: string; prompt_text: string; storage_path: string; width: number; height: number; created_at: string };
type Job = { id: string; status: string; stage: string; progress: number; attempt_count: number; error_message?: string; snapshot: { prompt: string; parentCheckpointId: string | null; variationIndex: number } };
type Workspace = { project: Project; materials: Material[]; checkpoints: Checkpoint[]; jobs: Job[] };

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: options?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? `Request failed (${response.status})`); }
  return response.status === 204 ? undefined as T : response.json();
}
const fileUrl = (storagePath: string) => `/api/files/${storagePath.split('/').map(encodeURIComponent).join('/')}`;

function ImageNode({ data, selected }: NodeProps) {
  const item = data.item as Checkpoint;
  return <div className={`image-node ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Top} />
    <img src={fileUrl(item.storage_path)} alt={item.prompt_text} />
    <div><span>{item.prompt_text}</span><small>{item.width} × {item.height}</small></div>
    <Handle type="source" position={Position.Bottom} />
  </div>;
}
const nodeTypes = { image: ImageNode };

function layout(checkpoints: Checkpoint[]) {
  const children = new Map<string | null, Checkpoint[]>(); checkpoints.forEach(cp => children.set(cp.parent_checkpoint_id, [...(children.get(cp.parent_checkpoint_id) ?? []), cp]));
  const positions = new Map<string, { x: number; y: number }>(); let leaf = 0;
  const place = (item: Checkpoint, depth: number): number => {
    const kids = children.get(item.id) ?? []; const x = kids.length ? kids.map(child => place(child, depth + 1)).reduce((a,b) => a+b,0) / kids.length : leaf++ * 250;
    positions.set(item.id, { x, y: depth * 250 }); return x;
  };
  (children.get(null) ?? []).forEach(root => place(root, 0));
  checkpoints.filter(cp => !positions.has(cp.id)).forEach(cp => place(cp, 0));
  return positions;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]); const [projectId, setProjectId] = useState<string | null>(null); const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [checked, setChecked] = useState<Set<string>>(new Set()); const [prompt, setPrompt] = useState(''); const [variations, setVariations] = useState(1);
  const [materials, setMaterials] = useState<Set<string>>(new Set()); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const refreshProjects = useCallback(async () => { const data = await api<Project[]>('/api/projects'); setProjects(data); setProjectId(current => current ?? data[0]?.id ?? null); }, []);
  const refresh = useCallback(async () => { if (projectId) setWorkspace(await api<Workspace>(`/api/projects/${projectId}/workspace`)); }, [projectId]);
  useEffect(() => { void refreshProjects(); }, [refreshProjects]); useEffect(() => { setSelected(null); setMaterials(new Set()); void refresh(); }, [refresh]);
  useEffect(() => { if (!projectId) return; const events = new EventSource(`/api/events?projectId=${projectId}`); const update = () => void refresh(); ['job.queued','job.running','job.progress','job.retrying','job.completed','job.failed','job.cancelled','material.created','material.deleted'].forEach(type => events.addEventListener(type, update)); return () => events.close(); }, [projectId, refresh]);

  const graph = useMemo(() => {
    if (!workspace) return { nodes: [], edges: [] }; const positions = layout(workspace.checkpoints);
    return { nodes: workspace.checkpoints.map(cp => ({ id: cp.id, type: 'image', position: positions.get(cp.id)!, data: { item: cp } })), edges: workspace.checkpoints.filter(cp => cp.parent_checkpoint_id).map(cp => ({ id: `${cp.parent_checkpoint_id}-${cp.id}`, source: cp.parent_checkpoint_id!, target: cp.id, animated: false, style: { stroke: '#8b8b92', strokeWidth: 1.5 } })) };
  }, [workspace]);
  const selectedCheckpoint = workspace?.checkpoints.find(cp => cp.id === selected);

  async function createProject() {
    const name = window.prompt('Project name', 'Untitled exploration'); if (!name) return;
    const project = await api<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }); await refreshProjects(); setProjectId(project.id);
  }
  async function submit() {
    if (!projectId || !prompt.trim()) return; setBusy(true); setError('');
    try {
      await api(`/api/projects/${projectId}/jobs`, { method: 'POST', body: JSON.stringify({ prompt, parentCheckpointId: selected, parentPromptVersionId: selectedCheckpoint?.prompt_version_id ?? null, materialIds: [...materials], variations, idempotencyKey: crypto.randomUUID(), settings: { size: '1024x1024', quality: 'medium', background: 'auto', outputFormat: 'png' } }) });
      setPrompt(''); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not queue job.'); } finally { setBusy(false); }
  }
  async function uploadMaterial(file: File) {
    if (!projectId) return; const form = new FormData(); form.append('image', file); form.append('label', file.name); setError('');
    try { await api(`/api/projects/${projectId}/materials`, { method: 'POST', body: form }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
  }
  async function downloadSelection() {
    const response = await fetch('/api/checkpoints/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...checked] }) });
    if (!response.ok) return setError('Could not create download.'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'image-flow-selection.zip'; anchor.click(); URL.revokeObjectURL(url);
  }

  return <div className="app-shell">
    <aside className="projects-panel">
      <div className="brand"><span className="brand-mark"><Sparkles size={18}/></span><strong>Image Flow</strong></div>
      <div className="aside-title"><span>Projects</span><button onClick={createProject} title="New project"><Plus size={16}/></button></div>
      <div className="project-list">{projects.map(project => <button key={project.id} className={project.id === projectId ? 'active' : ''} onClick={() => setProjectId(project.id)}><span>{project.name.slice(0,1).toUpperCase()}</span>{project.name}</button>)}</div>
      {workspace && <button className="archive" onClick={async () => { await api(`/api/projects/${workspace.project.id}`, { method:'PATCH', body:JSON.stringify({archived:true}) }); setProjectId(null); setWorkspace(null); await refreshProjects(); }}><Archive size={15}/> Archive project</button>}
    </aside>

    <main>
      <header><div><small>WORKSPACE</small><h1>{workspace?.project.name ?? 'Create your first project'}</h1></div>{checked.size > 0 && <button className="secondary" onClick={downloadSelection}><Download size={16}/> Download {checked.size}</button>}</header>
      <section className="canvas">
        {workspace?.checkpoints.length ? <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} fitView onNodeClick={(_,node) => setSelected(node.id)} onPaneClick={() => setSelected(null)}><Background color="#d8d7d2" gap={24}/><Controls showInteractive={false}/></ReactFlow> : <div className="empty"><div><ImagePlus size={28}/></div><h2>Your idea starts here</h2><p>Describe an image below. Every result becomes a checkpoint you can safely branch from.</p></div>}
      </section>
      <section className="composer">
        <div className="context-row">{selectedCheckpoint ? <span className="context"><img src={fileUrl(selectedCheckpoint.storage_path)}/> Forking from checkpoint <button onClick={() => setSelected(null)}><X size={13}/></button></span> : <span className="fresh">New root generation · isolated context</span>}</div>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder={selected ? 'Describe what should change…' : 'Describe the image you want to create…'} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit(); }}/>
        <div className="compose-actions"><div className="variation-control"><span>Variations</span>{[1,2,3,4].map(n => <button className={n===variations?'active':''} onClick={() => setVariations(n)} key={n}>{n}</button>)}</div><button className="generate" disabled={busy || !prompt.trim() || !projectId} onClick={submit}>{busy ? <LoaderCircle className="spin" size={17}/> : <Sparkles size={17}/>} Queue generation</button></div>
        {error && <p className="error">{error}</p>}
      </section>
    </main>

    <aside className="right-panel">
      <section className="materials"><div className="panel-title"><div><small>INPUTS</small><h3>Materials</h3></div><label title="Upload reference"><Upload size={16}/><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => e.target.files?.[0] && void uploadMaterial(e.target.files[0])}/></label></div>
        <p>Select only the references this iteration should see.</p>
        <div className="material-grid">{workspace?.materials.map(item => <button key={item.id} className={materials.has(item.id)?'selected':''} onClick={() => setMaterials(current => { const next=new Set(current); next.has(item.id)?next.delete(item.id):next.add(item.id); return next; })}><img src={fileUrl(item.storage_path)}/><span>{materials.has(item.id)&&<Check size={12}/>}</span><small>{item.label}</small></button>)}</div>
      </section>
      {selectedCheckpoint && <section className="inspector"><small>CHECKPOINT</small><div className="preview-select"><img src={fileUrl(selectedCheckpoint.storage_path)}/><button onClick={() => setChecked(current => { const next=new Set(current); next.has(selectedCheckpoint.id)?next.delete(selectedCheckpoint.id):next.add(selectedCheckpoint.id); return next; })}>{checked.has(selectedCheckpoint.id)?<Check size={15}/>:<Square size={15}/>} Select</button></div><p>{selectedCheckpoint.prompt_text}</p><div className="meta"><span>{selectedCheckpoint.width} × {selectedCheckpoint.height}</span><span>{new Date(selectedCheckpoint.created_at).toLocaleString()}</span></div><a className="download" href={`/api/checkpoints/${selectedCheckpoint.id}/download`}><Download size={15}/> Download image</a></section>}
      <section className="jobs"><div className="panel-title"><div><small>ACTIVITY</small><h3>Jobs</h3></div><span className="live-dot">LIVE</span></div>
        <div className="job-list">{workspace?.jobs.map(job => <div className="job" key={job.id}><div className={`status ${job.status}`}>{['running','retrying'].includes(job.status)?<LoaderCircle className="spin" size={14}/>:job.status==='completed'?<Check size={14}/>:job.status==='failed'?<X size={14}/>:<span/>}</div><div className="job-copy"><strong>{job.snapshot.prompt}</strong><small>{job.stage || job.status}{job.attempt_count ? ` · attempt ${job.attempt_count}` : ''}{job.snapshot.variationIndex ? ` · variation ${job.snapshot.variationIndex+1}`:''}</small><div className="progress-track" title={job.stage?.includes('estimated') ? 'OpenAI does not expose exact image-generation progress; this portion is estimated.' : job.stage}><span style={{width:`${job.progress ?? 0}%`}}/></div><div className="progress-caption"><span>{job.stage?.includes('estimated') ? 'Estimated progress' : 'Progress'}</span><b>{job.progress ?? 0}%</b></div>{job.error_message&&<em>{job.error_message}</em>}</div><div className="job-actions">{['queued','running','retrying'].includes(job.status)&&<button title="Cancel" onClick={() => void api(`/api/jobs/${job.id}/cancel`,{method:'POST'})}><X size={14}/></button>}{job.status==='failed'&&<button title="Retry identical request" onClick={() => void api(`/api/jobs/${job.id}/retry`,{method:'POST'})}><RotateCcw size={14}/></button>}</div></div>)}</div>
      </section>
    </aside>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
