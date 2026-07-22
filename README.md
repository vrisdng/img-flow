# Image Flow

A local, durable workspace for branching image generation and edits with OpenAI.

## Run

1. Put `OPENAI_API_KEY` in `.env` (already supported by this workspace).
2. Run `npm install` and `npm run dev`.
3. Open http://127.0.0.1:5173.

If a previous development run is still open, stop it with `Ctrl+C` before starting again. Development uses strict ports so the UI cannot silently move to another port or remain alive without its API.

The API binds to `127.0.0.1:4310`. Supabase Postgres stores application state and the private `image-flow` Storage bucket holds all images. `npm run dev` starts the UI, API, and independent worker. Use `npm test` and `npm run build` to verify the project.

Each job snapshots its prompt, parent checkpoint, materials, settings, and model. Infrastructure retries reuse that snapshot; creative iterations create new prompt versions and tree nodes.
