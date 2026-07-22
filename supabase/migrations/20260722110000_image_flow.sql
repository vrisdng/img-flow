create extension if not exists pgcrypto;

create table if not exists public.projects (id uuid primary key default gen_random_uuid(), name text not null, archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.materials (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade, label text not null, sha256 text not null, mime_type text not null, width int not null, height int not null, size_bytes bigint not null, storage_path text not null, created_at timestamptz not null default now(), unique(project_id,sha256));
create table if not exists public.prompt_versions (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade, parent_prompt_version_id uuid references public.prompt_versions, text text not null, created_at timestamptz not null default now());
create table if not exists public.branches (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade, root_checkpoint_id uuid, created_at timestamptz not null default now());
create table if not exists public.jobs (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade, branch_id uuid not null references public.branches on delete cascade, status text not null check(status in('queued','running','retrying','completed','failed','cancelled')), stage text not null default 'Queued', progress int not null default 5 check(progress between 0 and 100), snapshot_json jsonb not null, idempotency_key text not null unique, attempt_count int not null default 0, max_attempts int not null default 3, next_attempt_at timestamptz not null default now(), lease_owner text, lease_expires_at timestamptz, cancel_requested boolean not null default false, error_category text, error_message text, openai_request_id text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table if not exists public.checkpoints (id uuid primary key default gen_random_uuid(), project_id uuid not null references public.projects on delete cascade, branch_id uuid not null references public.branches on delete cascade, parent_checkpoint_id uuid references public.checkpoints, prompt_version_id uuid not null references public.prompt_versions, job_id uuid not null unique references public.jobs, storage_path text not null, mime_type text not null, sha256 text not null, width int not null, height int not null, size_bytes bigint not null, created_at timestamptz not null default now());
create table if not exists public.job_attempts (id uuid primary key default gen_random_uuid(), job_id uuid not null references public.jobs on delete cascade, attempt_number int not null, status text not null, error_category text, error_message text, openai_request_id text, started_at timestamptz not null default now(), finished_at timestamptz);
create table if not exists public.job_materials (job_id uuid not null references public.jobs on delete cascade, material_id uuid not null references public.materials, position int not null, primary key(job_id,material_id));
create table if not exists public.events (id bigint generated always as identity primary key, type text not null, project_id uuid, payload_json jsonb not null, created_at timestamptz not null default now());
create index if not exists jobs_ready_idx on public.jobs(status,next_attempt_at);
create index if not exists checkpoints_project_idx on public.checkpoints(project_id,created_at);
create index if not exists events_project_idx on public.events(project_id,id);

alter table public.projects enable row level security; alter table public.materials enable row level security; alter table public.prompt_versions enable row level security; alter table public.branches enable row level security; alter table public.jobs enable row level security; alter table public.checkpoints enable row level security; alter table public.job_attempts enable row level security; alter table public.job_materials enable row level security; alter table public.events enable row level security;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('image-flow','image-flow',false,20971520,array['image/png','image/jpeg','image/webp']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.lease_image_flow_job(p_owner text, p_lease_seconds int default 120)
returns setof public.jobs language plpgsql security definer set search_path=public as $$
declare v_job public.jobs;
begin
  select * into v_job from public.jobs where status in ('queued','retrying') and not cancel_requested and next_attempt_at<=now() order by created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.jobs set status='running',stage='Preparing inputs',progress=10,attempt_count=attempt_count+1,lease_owner=p_owner,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.job_attempts(job_id,attempt_number,status) values(v_job.id,v_job.attempt_count,'running');
  insert into public.events(type,project_id,payload_json) values('job.running',v_job.project_id,jsonb_build_object('jobId',v_job.id,'attempt',v_job.attempt_count));
  return next v_job;
end $$;
revoke all on function public.lease_image_flow_job(text,int) from public,anon,authenticated;
grant execute on function public.lease_image_flow_job(text,int) to service_role;
