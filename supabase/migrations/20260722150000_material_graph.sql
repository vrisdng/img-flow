create table if not exists public.material_groups (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade,
  label text not null, color text not null default '#8b8b92', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.material_group_members (
  group_id uuid not null references public.material_groups on delete cascade, material_id uuid not null references public.materials on delete cascade,
  position int not null, created_at timestamptz not null default now(), primary key(group_id,material_id)
);
create table if not exists public.canvas_nodes (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade,
  node_type text not null check(node_type in('material','group','generation','checkpoint')), entity_id uuid,
  position_x double precision not null default 0, position_y double precision not null default 0,
  width double precision, height double precision, config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.canvas_edges (
  id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade,
  source_node_id uuid not null references public.canvas_nodes on delete cascade, target_node_id uuid not null references public.canvas_nodes on delete cascade,
  edge_type text not null check(edge_type in('group_include','group_input','checkpoint_input','generation_output')),
  position int not null default 0, created_at timestamptz not null default now(), unique(source_node_id,target_node_id,edge_type)
);
create index if not exists material_groups_project_idx on public.material_groups(project_id);
create index if not exists canvas_nodes_project_idx on public.canvas_nodes(project_id);
create index if not exists canvas_edges_project_idx on public.canvas_edges(project_id,position);
alter table public.material_groups enable row level security;
alter table public.material_group_members enable row level security;
alter table public.canvas_nodes enable row level security;
alter table public.canvas_edges enable row level security;
