# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

"냉장고를 부탁해" (fridge-chef): upload a fridge photo, recognize ingredients with an OpenRouter vision model, generate recipes with an OpenRouter text model, and save them. The app is a Node/Express container, deployed to Azure Container Apps.

The specs are in `PRD_step1.md` (recognition, plus the server, container and Git groundwork), `PRD_step2.md` (recipes) and `PRD_step3.md` (storage and ACA deployment). Build the steps in order, and follow the API shapes, error codes and env vars the PRDs define. **Step 1 is implemented. Steps 2 and 3 are not.**

## Commands

Node.js 22+ (ESM, built-in `fetch`). No build step and no linter.

- `npm install`
- `npm run dev`: start the server with auto-reload (http://localhost:8080). Use `npm start` to run it without reload.
- `npm test`: run all tests. They never call the real API.
- `node --test test/api.test.js`: run one test file. Add `--test-name-pattern "413"` to run a single test.
- `npm run check`: print the loaded config, with keys masked
- `npm run test:openrouter [image path or URL]`: run live OpenRouter text and image calls. This uses the real key and the free-model quota.
- `docker build -t fridge-chef .` then `docker run --rm -p 8080:8080 --env-file .env fridge-chef`

The `test` script uses the glob `test/**/*.test.js` on purpose. A bare `node --test` also matches the root-level `test-openrouter.js` and would make live API calls.

## Architecture

- `src/config.js` is the only module that reads `process.env`. It validates values at import time and exports a frozen `config` and `mask()`. Other modules import `config`.
- `src/app.js` exports `createApp({ chat })`; `src/server.js` only listens on the port. Routes receive `chat` by injection, so tests (`test/api.test.js`) pass a fake `chat` and never hit OpenRouter. Keep this injection when you add the step 2 and 3 routes.
- Model call pipeline:
  1. `lib/openrouter.js` `chat()`: retries on 429; the timeout covers all retries; logs each call's status, duration and token count
  2. `lib/json.js` `chatJson()`: extracts the text from the first `{` to the last `}`, validates it with a zod schema, and re-asks once on failure
  3. A domain schema validates the result. `lib/ingredients.js` drops bad items and defaults the fields it can fix, then merges synonyms and duplicates.
- Errors: throw `AppError` (from the `errors.*` factories in `lib/errors.js`). The Express error handler turns it into `{ error: { code, message } }`, where `message` is Korean text for the user.
- Prompts live in `src/prompts/`. The frontend is static `public/` files (vanilla JS, no build). It inserts model output with `textContent` only.

## Model behaviour (free `nvidia/nemotron-3.5-super-vl:free`)

- Images must be sent as base64 `data:` URLs. Plain image URLs return `404 No endpoints found that support image URLs`. `lib/image.js` uses sharp to resize images to 1280px and convert them to JPEG, which also strips EXIF data.
- The prebuilt sharp can't decode HEIC. The browser converts HEIC to JPEG before upload (`prepareImage` in `public/app.js`).
- The model is slow. It produces about 2,300 reasoning tokens per photo, and recognition took 17–58s, so the default timeout is 90s. Setting `reasoning.effort: low` made it slower. 429 rate limits happen.

## Secrets

- `.env` holds real keys and is excluded by `.gitignore` and `.dockerignore`. Never print, log or commit its values. In ACA, keys come in as secrets.
- When you add a variable, also add it to `.env.example` with an empty value. `GEMINI_*` is optional; it's used only by `example.js`, not the app.
