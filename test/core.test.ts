import { describe, expect, it } from 'vitest';
import { classifyError, retryDelay } from '../src/errors.js';
import { buildImagePrompt } from '../src/image-prompt.js';

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

describe('numbered image references', () => {
  it('keeps material numbers independent from the base checkpoint', () => {
    const prompt = buildImagePrompt('Use material 2 for the lighting.', true, ['pose.png', 'light.jpg']);
    expect(prompt).toContain('Base checkpoint: input image 1');
    expect(prompt).toContain('Material 1: input image 2 (pose.png)');
    expect(prompt).toContain('Material 2: input image 3 (light.jpg)');
  });
  it('maps root materials from input image one', () => {
    expect(buildImagePrompt('Match material 1.', false, ['style.png'])).toContain('Material 1: input image 1');
  });
});
