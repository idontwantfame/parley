# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the bot (src/index.js). Requires the STT sidecar running too.
- `npm test` — run all unit tests (`node --test`).
- `npm run sidecar` — start the Python faster-whisper STT sidecar (stt_sidecar/server.py).
- Sidecar tests: `cd stt_sidecar && .venv/bin/python -m pytest -q` (all test files; whisperx/torch are faked, so the default requirements suffice) (create the venv first: `python3 -m venv stt_sidecar/.venv && stt_sidecar/.venv/bin/pip install -r stt_sidecar/requirements.txt`).
- If npm refuses install scripts (strict allow-scripts), `npm ci --ignore-scripts` is enough for the tests; `postinstall` applies scripts/patch-discord-voice.mjs.
- Run a single Node test file: `node --test test/<name>.test.js`.
- Requires Node >= 22.5 (uses the built-in `node:sqlite`).

## Architecture (big picture)

Two processes: a Node (discord.js, ESM) bot + a persistent Python FastAPI sidecar running faster-whisper with the model loaded once (warm).

Per-user Discord audio streams give free speaker attribution (no ML diarization): each speaker's track is transcribed separately and tagged with their display name, then merged by timestamp.

Flow: capture per-speaker PCM → on meeting end, orchestrator (src/pipeline/orchestrator.js) transcribes each track via the sidecar → stores utterances in SQLite → summarizes via a pluggable adapter → saves summary → delivers a structured notes thread to Discord.

Concurrency: at most ONE active meeting per guild — Discord allows a bot in one voice channel per guild and @discordjs/voice keeps one connection per guild, so joining a second channel would silently move the bot. src/voice/guild-voice-gate.js + meeting-manager.js enforce this (/join elsewhere is refused; auto-join skips busy guilds). Different guilds record concurrently. Auto-leave waits a grace period (AUTO_LEAVE_GRACE_MS) so brief reconnects don't split a meeting.

Pluggable summarizer (src/adapters/summarizer/): gemini (default), ollama, openai, opencode, openrouter — all return the same StructuredNotes shape. Chosen per-guild via /setup.

Storage: src/store/db.js (node:sqlite, FTS5 for /search). Per-guild runtime config in src/store/config.js.

Campaigns (src/campaign/): cross-session memory. A campaign groups meetings (meetings.campaign_id); voice channels link to one via campaign_channels, so createMeeting files new recordings automatically. After a campaign session is summarized, the orchestrator folds its transcript into the campaign journal (one LLM-rewritten Markdown doc of world state, via the adapter's ask(); meetings.journaled_at marks folded sessions; per-campaign lock + shrinkage guard in journal.js). The journal is passed to summarize() as meta.campaignContext (appended in notes.js summaryPrompt). /ask and /recap (ask.js) build context from journal + numbered session notes + FTS5-matched transcript excerpts — never whole transcripts.

Imports (src/pipeline/import.js, src/web/import-routes.js): admins upload a recording made outside Discord (raw request body, streamed to DATA_DIR/imports); ffmpeg converts it to the meeting's mixed.mp3 (+ mixed.json origin) and the sidecar transcribes it. Speaker detection is optional: the sidecar's `-full` image (WITH_DIARIZATION=1) runs WhisperX alignment + pyannote community-1 when HF_TOKEN is set (stt_sidecar/whisperx_backend.py, diarize.py); otherwise every line is "Speaker 1". Speakers get per-meeting ids `import-<meetingId>-<n>`, renamed via speaker_names. Transcript lines are sentence-level with epoch start_ms; the meeting page player seeks to start_ms - audioOriginMs.

Shared microphones (src/pipeline/transcribe.js): guild config `sharedMicUserIds` marks Discord accounts several people talk through. Their turns are joined without the silence between them (concatTracksToWav in src/voice/mix.js) and diarized by the sidecar in one job; times map back to the meeting timeline. Voices get per-meeting ids `shared-<meetingId>-<userId>-<n>` (`-0` = unattributed speech). The meeting then waits in status `speaker_review` (audio kept, Discord notice posted) until an admin names the voices (POST /meetings/:id/speaker-review), then it is summarized. Turning a shared mic on is refused unless the sidecar reports speaker detection.

Dashboard SSO (OIDC, off by default): src/web/oidc*.js + auth-settings-routes.js, settings in src/config/auth-settings.js / src/store/oidc-settings.js (env OIDC_*, PUBLIC_URL, PASSWORD_LOGIN; dashboard writes .env via persistEnv). Uses openid-client v6 (code flow + PKCE); identity = users.(oidc_issuer, oidc_subject); link by verified email only; optional admin-group sync never demotes the last admin; password login can't be turned off unless the acting admin is SSO-linked, and only takes effect once an admin SSO sign-in has verified the current settings fingerprint (OIDC_VERIFIED in .env; any provider/URL/group change clears it). Recovery: PASSWORD_LOGIN=true + restart.

Security/ops conventions: the server sends a strict Content-Security-Policy (src/web/security-headers.js) — any new external script, style, font, image or API origin used by the UI must be added there. Requests get a 5-minute deadline (src/web/request-deadline.js); only admin import uploads get 2 h. The first-run admin password is random and printed once to the log. Parley↔sidecar auth: optional shared STT_API_KEY (Bearer), see src/adapters/stt-access.js and stt_sidecar/request_guard.py; the sidecar returns 503 busy + Retry-After when its queue is full, which the client waits on. Imports run one at a time (createSerialQueue in src/pipeline/import.js).

Slash commands: /join /leave /summary /history /search /ask /recap /journal /campaign /setup (src/commands/). Auto-join when >1 human, auto-leave when ≤1 (src/voice/decisions.js).

## Key conventions / gotchas

- `DATA_DIR` resolved once in src/config/env.js (`DATA_DIR` env → `/data` if present → cwd). SQLite db + audio/ live under it.
- Secrets (DISCORD_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY, OLLAMA_URL) live in .env ONLY — /setup never accepts API keys (Discord retains message content). /setup picks provider/model/behavior and validates the needed key exists in env.
- Summarizer adapters return StructuredNotes { tldr, topics[], decisions[], openQuestions[], actionItems[{assignee,task}] }; action items are rendered grouped per person.
- Bot uses minimal gateway intents [Guilds, GuildVoiceStates] — do NOT add MessageContent (privileged; would fail login).
- PCM filenames are `audio/<meetingId>/<userId>_<startMs>.pcm` (avoids the v1 underscore-in-name parsing bug).
