import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@supabase/server/core';

// The remote schema is versioned in supabase/migrations. A generated Database type can
// replace this boundary later without changing the persistence adapters.
export const supabase: any = createAdminClient();
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function must<T>(result: { data: T; error: { message: string } | null }): T { if (result.error) throw new Error(result.error.message); return result.data; }
export async function emit(type: string, projectId: string | string[] | null, payload: unknown) {
  must(await supabase.from('events').insert({ type, project_id: projectId, payload_json: payload }).select().single());
}
