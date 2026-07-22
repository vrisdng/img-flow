export type Failure = { category: string; message: string; transient: boolean; requestId?: string; retryAfterMs?: number };

export function classifyError(error: unknown): Failure {
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : undefined;
  const requestId = typeof error === 'object' && error && 'request_id' in error ? String((error as { request_id: unknown }).request_id) : undefined;
  const headers = typeof error === 'object' && error && 'headers' in error ? (error as { headers?: Headers }).headers : undefined;
  const retryAfter = headers?.get?.('retry-after'); const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) : undefined;
  if (status === 401 || status === 403) return { category: 'authentication', message: 'OpenAI rejected the API credentials.', transient: false, requestId };
  if (status === 400 || status === 404 || status === 422) return { category: 'validation', message: 'OpenAI could not process these image inputs or settings.', transient: false, requestId };
  if (status === 429) return { category: 'rate_limit', message: 'OpenAI rate limit reached; the job will retry.', transient: true, requestId, retryAfterMs };
  if (status && status >= 500) return { category: 'provider', message: 'OpenAI is temporarily unavailable; the job will retry.', transient: true, requestId, retryAfterMs };
  if (error instanceof Error && /abort/i.test(error.name + error.message)) return { category: 'cancelled', message: 'The job was cancelled.', transient: false };
  return { category: 'network', message: 'The image request failed due to a temporary network error.', transient: true, requestId };
}

export function retryDelay(attempt: number, requested?: number, jitter = Math.floor(Math.random() * 500)) {
  const exponential = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.max(requested ?? 0, exponential + jitter);
}
