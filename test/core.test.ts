import { describe, expect, it } from 'vitest';
import { classifyError, retryDelay } from '../src/errors.js';

describe('OpenAI error policy', () => {
  it('retries rate limits and honors retry-after', () => {
    const failure = classifyError({ status: 429, request_id: 'req_123', headers: new Headers({ 'retry-after': '7' }) });
    expect(failure).toMatchObject({ category: 'rate_limit', transient: true, requestId: 'req_123', retryAfterMs: 7000 });
    expect(retryDelay(1, failure.retryAfterMs, 0)).toBe(7000);
  });
  it('does not retry invalid credentials or validation failures', () => {
    expect(classifyError({ status: 401 }).transient).toBe(false);
    expect(classifyError({ status: 422 }).transient).toBe(false);
  });
  it('uses bounded exponential backoff', () => {
    expect(retryDelay(1, undefined, 0)).toBe(1000);
    expect(retryDelay(3, undefined, 0)).toBe(4000);
    expect(retryDelay(20, undefined, 0)).toBe(30000);
  });
});
