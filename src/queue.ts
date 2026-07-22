import { emit, must, now, supabase } from './db.js';
import type { JobSnapshot } from './types.js';

export type LeasedJob = { id:string; project_id:string; branch_id:string; attempt_count:number; max_attempts:number; snapshot:JobSnapshot };
export async function recoverExpiredLeases() {
  const { data, error } = await supabase.from('jobs').select('id,project_id').eq('status','running').lt('lease_expires_at',now()); if (error) throw error;
  for (const job of data ?? []) { must(await supabase.from('jobs').update({ status:'queued',stage:'Recovered after restart',progress:5,lease_owner:null,lease_expires_at:null,next_attempt_at:now(),updated_at:now() }).eq('id',job.id).select()); await emit('job.recovered',job.project_id,{jobId:job.id}); }
}
export async function leaseNext(owner:string):Promise<LeasedJob|null> {
  const { data,error }=await supabase.rpc('lease_image_flow_job',{p_owner:owner,p_lease_seconds:120}); if(error) throw error; const row=data?.[0];
  return row?{id:row.id,project_id:row.project_id,branch_id:row.branch_id,attempt_count:row.attempt_count,max_attempts:row.max_attempts,snapshot:row.snapshot_json as JobSnapshot}:null;
}
export async function renewLease(jobId:string,owner:string){await supabase.from('jobs').update({lease_expires_at:new Date(Date.now()+120000).toISOString()}).eq('id',jobId).eq('lease_owner',owner).eq('status','running');}
export async function cancellationRequested(jobId:string){const {data}=await supabase.from('jobs').select('cancel_requested').eq('id',jobId).maybeSingle();return data?.cancel_requested===true;}
export async function finishAttempt(jobId:string,status:string,details:{category?:string;message?:string;requestId?:string}={}){await supabase.from('job_attempts').update({status,error_category:details.category??null,error_message:details.message??null,openai_request_id:details.requestId??null,finished_at:now()}).eq('job_id',jobId).is('finished_at',null);}
export async function updateProgress(jobId:string,projectId:string,stage:string,progress:number){const bounded=Math.max(0,Math.min(100,Math.round(progress)));await supabase.from('jobs').update({stage,progress:bounded,updated_at:now()}).eq('id',jobId).eq('status','running');await emit('job.progress',projectId,{jobId,stage,progress:bounded,estimated:stage.includes('OpenAI')});}
