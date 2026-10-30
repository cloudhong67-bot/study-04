# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

"냉장고를 부탁해" (fridge-chef): upload a fridge photo, recognize ingredients with a vision model, generate recipes with a text model, and save them. The AI is Google Gemini by default (`AI_PROVIDER=gemini`, model `gemini-3.5-flash-lite`); OpenRouter remains selectable with `AI_PROVIDER=openrouter`. The app is a Node/Express container, deployed to Azure Container Apps.

The specs are in `PRD_step1.md` (recognition, plus the server, container and Git groundwork), `PRD_step2.md` (recipes) and `PRD_step3.md` (storage and ACA deployment). Build the steps in order, and follow the API shapes, error codes and env vars the PRDs define. **All three steps are implemented.** Step 3 has not yet been deployed to Azure; see `DEPLOY.md`. Each PRD ends with implementation notes on deviations and measurements.

## Commands

Node.js 22+ (ESM, built-in `fetch`). No build step and no linter.

- `npm install`
- `npm run dev`: start the server with auto-reload (http://localhost:8080). Use `npm start` to run it without reload.
- `npm test`: run all tests. They never call the real API.
- `node --test test/api.test.js`: run one test file. Add `--test-name-pattern "413"` to run a single test.
- `npm run check`: print the loaded config, with keys masked
- `npm run test:openrouter [image path or URL]`: run live OpenRouter text and image calls (OpenRouter only, whatever `AI_PROVIDER` is). This uses the real key and the free-model quota. `npm run example` calls OpenRouter and native Gemini once each.
- `docker build -t fridge-chef .` then `docker run --rm -p 8080:8080 --env-file .env -v fridge-chef-data:/app/data fridge-chef`. The volume keeps saved recipes across restarts.
- To run against Cosmos locally, start the emulator and run `node scripts/cosmos-emulator-setup.js`. `DEPLOY.md` has the exact commands, including running the contract tests against Cosmos.
- Deploy: `infra/deploy.sh` does the first deploy (needs `az`). After that, `.github/workflows/ci-cd.yml` builds in ACR and updates the Container App on each push to `main`. To validate infra: `bicep build infra/main.bicep`.

The `test` script uses the glob `test/**/*.test.js` on purpose. A bare `node --test` also matches the root-level `test-openrouter.js` and would make live API calls.

## Architecture

- `src/config.js` is the only module that reads `process.env`. It validates values at import time and exports a frozen `config` and `mask()`. Other modules import `config`.
- Auth (`lib/auth.js`, `routes/auth.js`): email+password with scrypt hashes, and a stateless HMAC-signed session cookie `fc_session` (HttpOnly, SameSite=Lax, Secure on HTTPS) keyed by `SESSION_SECRET`.
  - `createApp` runs `authenticate` on every request, then `sameOrigin` and `requireUser` on `/api`. Only `/healthz`, `/api/auth/*`, `/login.html` and static assets are public; `/` redirects to the login page.
  - The frontend redirects to `/login.html` on any 401 (`requestJson` in `public/app.js`).
  - `SESSION_SECRET` is required when `NODE_ENV=production` (the Docker image sets that). In dev, a missing secret gets a temporary key, so sessions die on restart.
- `src/app.js` exports `createApp({ chat, rateLimit, storage, auth })`; `src/server.js` only listens on the port. Routes receive `chat` by injection, so tests pass a fake `chat` and never hit the real AI. Test files set `GEMINI_API_KEY`/`OPENROUTER_API_KEY` to `test-key` when unset, so they run without `.env` (as in CI). Tests use `test/helpers.js` `startApp()`, which provides a temp file storage and a fixed test secret; `signup()` returns a session cookie to send as the `Cookie` header. Tests also pass `rateLimit: false`, because the per-IP limits (10/min for recognition, 5/min for recipes, in `lib/rate-limit.js`) would otherwise trip. Saved-recipe routes are mounted only when `createApp` gets a `storage`. `server.js` creates it with `createStorage(config.storage)`.
- Model call pipeline:
  1. `lib/ai.js` `chat()`: posts to the provider's OpenAI-compatible `/chat/completions` (`config.ai`: Gemini's `/v1beta/openai` path, or OpenRouter). `requestBody()` holds the provider differences (reasoning params). Gemini may return error bodies as an array (`[{ error }]`). Retries on 429; the timeout covers all retries; logs each call's status, duration and token count. Errors after the `200` headers arrive as a `200` body with `error.code` and no `choices`, so `chat()` treats `error.code` as the status (a body 429 is retried like an HTTP 429).
  2. `lib/json.js` `chatJson()`: extracts the text from the first `{` to the last `}`, validates it with a zod schema, and re-asks once on failure. The re-ask (`repairMessages`) drops images and sends the previous answer as an assistant message plus a "JSON only" instruction; if the previous answer was empty, it resends the original request.
  3. A domain schema validates the result. `lib/ingredients.js` drops bad items and defaults the fields it can fix, then merges synonyms and duplicates.
- Recipes (`lib/recipes.js`): the server, not the model, decides `owned`, `basic` (pantry staples) and `missingIngredients` by matching against the user's list. `finalizeRecipes` then drops recipes with more than 2 missing ingredients, diet violations (keyword rules in `DIETARY_RULES`), excluded titles, duplicates, and recipes over 32KB (`MAX_RECIPE_BYTES`, which the save API also enforces, so users never see a recipe they can't save). `DIETARY_RULES` is a safety net for allergies too: when adding keywords, prefer false positives over misses, and use `NOT_KEYWORD` for known false hits (e.g. 오리엔탈). It sorts by missing count and attaches UUIDs. The route asks the model for one extra recipe to absorb what the filter drops. `chatJson`'s `timeoutMs` is the total budget, including the JSON re-ask.
- Storage (`src/storage/`) has two drivers behind one interface, documented in `index.js`: `file` (JSON in `DATA_DIR`, writes serialized, single process only) and `cosmos` (partition key `/clientId`, managed identity, or `COSMOS_KEY` for the emulator only).
  - `test/storage.test.js` is a contract test both drivers must pass. The cosmos half runs only when `COSMOS_TEST_ENDPOINT` and `COSMOS_TEST_KEY` are set; CI sets them and runs the emulator.
  - Paging uses a `(savedAt, id)` keyset cursor (`order.js`), not Cosmos continuation tokens, because the emulator ignores page size for ORDER BY queries.
  - `list` returns summaries only (`toListItem` in `order.js`; Cosmos projects the same fields), not full entries.
  - `infra/main.bicep` and `scripts/cosmos-emulator-setup.js` must keep the same container settings: partition key, composite index, and the `users` container's no-index policy (`excludedPaths: /*`; users are only point-read).
- Saved recipes (`routes/saved.js`): the storage `clientId` field holds the logged-in user's id; the name was kept so the Cosmos partition key didn't change. Other users' items return 404. Users live in `storage.users`; each user doc's id is the lowercased email, with Cosmos partition key `/id`. On save, the server recomputes `owned` and `missingIngredients` from `ownedIngredients` via `markOwnership`.
- Errors: throw `AppError` (from the `errors.*` factories in `lib/errors.js`). The Express error handler turns it into `{ error: { code, message } }`, where `message` is Korean text for the user. For zod failures use `invalidRequestFrom(zodError, where)`: it logs the zod detail and sends a fixed Korean message (schema messages that start with Hangul are passed through).
- `createApp` sets `X-Content-Type-Options`, `Referrer-Policy` and a CSP (`default-src 'self'`, `img-src 'self' blob: data:`, `frame-ancestors 'none'`). The frontend must stay free of external resources and inline scripts/styles, or the CSP in `src/app.js` must be updated.
- JSON body limits: 8kb for `/api/auth`, 40kb for `/api/recipes` (a 32KB recipe plus `ownedIngredients`). An oversized body gets `400 INVALID_REQUEST` with a "content too long" message.
- Prompts live in `src/prompts/`. The frontend is static `public/` files (vanilla JS, no build). It inserts model output with `textContent` only.

## Model behaviour

### Gemini (default, `gemini-3.5-flash-lite`)

- Switched from OpenRouter on 2026-10-30 because the free OpenRouter model kept failing to connect or timing out.
- Measured with the project key, short prompt: `gemini-3.5-flash-lite` ~1s, `gemini-3.6-flash` ~3s, `gemini-3.1-flash-lite` ~6s, `gemini-3.8-flash` no answer within 40s. `gemini-2.5-*` returns 404 for new users.
- Full app flow on a fruit photo: recognition ~3.5s, 3 recipes ~3.8s, in Korean, diet conditions respected.
- `AI_REASONING=off` sends `reasoning_effort: "minimal"`. Gemini 3.x thinking can't be fully turned off, and some models (e.g. `gemini-3.8-flash`) don't accept `minimal`; use `AI_REASONING=on` (model default) for those.
- Images go as the same base64 `data:` URLs as with OpenRouter.

### OpenRouter (free `nvidia/nemotron-3.5-super-vl:free`, `AI_PROVIDER=openrouter`)

- Images must be sent as base64 `data:` URLs. Plain image URLs return `404 No endpoints found that support image URLs`. `lib/image.js` uses sharp to resize images to 1280px and convert them to JPEG, which also strips EXIF data. It refuses images over 50M pixels (`limitInputPixels`) with `413 IMAGE_TOO_LARGE`.
- The browser (`prepareImage`) also shrinks to 1280px JPEG before upload, so the server's resize is usually a no-op. The browser accepts originals up to 50MB and checks the 10MB server limit on the shrunk file.
- The prebuilt sharp can't decode HEIC. The browser converts HEIC to JPEG before upload (`prepareImage` in `public/app.js`).
- Reasoning is **off by default**: `chat()` sends `reasoning: { enabled: false }`, controlled by `AI_REASONING` (`off`/`on`; the old name `OPENROUTER_REASONING` is still read).
  - With reasoning on, this model was too slow. Recognition took 11–90s+ and recipes took 28–120s+, with regular timeouts.
  - With it off, recognition takes 2–4s and recipes take 7–9s, with similar results.
  - `reasoning.effort: low` is not an alternative; it made the model slower.
- Timeouts stay as safety nets for both providers: 90s for recognition (`AI_TIMEOUT_MS`, old name `OPENROUTER_TIMEOUT_MS`), 120s for recipes (`RECIPE_TIMEOUT_MS`). 429 rate limits happen.
- Without reasoning the model occasionally mixes in English words. Both prompts say "한국어로만"; keep that rule.
- OpenRouter sends `200` headers immediately and the body only when the model finishes. Timeouts therefore usually fire during `res.json()`, not `fetch()`. `chat()` maps both cases to `MODEL_TIMEOUT` (see `test/ai.test.js`).

### Frontend

- In `public/style.css`, `[hidden] { display: none !important; }` is required. Without it, rules like `.loading { display: flex }` override the `hidden` attribute.

## Manual API testing on Windows

Don't put Korean JSON inline with `curl -d '...'` in Git Bash. It isn't sent as UTF-8, so the server gets garbled names and every ingredient comes back as not owned. Write the body to a file with Node and use `--data-binary @file.json`.

## Secrets

- `.env` holds real keys and is excluded by `.gitignore` and `.dockerignore`. Never print, log or commit its values. In ACA, keys come in as secrets.
- When you add a variable, also add it to `.env.example` with an empty value. Only the selected provider's key is required (`GEMINI_API_KEY` by default). ACA gets the Gemini key as the `gemini-api-key` secret (`infra/main.bicep`, `infra/deploy.sh`).
