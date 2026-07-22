import 'dotenv/config';
export const config = {
  host: '127.0.0.1',
  port: Number(process.env.IMAGE_FLOW_PORT ?? 4310),
  model: process.env.IMAGE_FLOW_MODEL ?? 'gpt-image-2-2026-04-21',
  concurrency: Math.max(1, Number(process.env.IMAGE_FLOW_CONCURRENCY ?? 2)),
  apiKey: process.env.OPENAI_API_KEY,
};
