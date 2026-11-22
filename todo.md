# Parley — session todos

Source: codebase + UI audit conducted this session. Each item carries file:line pointers and a severity.

## Done this session

- [x] `src/web/api.js:251` — gate `PATCH /todos/:id` behind `requireAdmin`. Action-item toggle now admin-only; non-admin receives 403.
- [x] `src/pipeline/orchestrator.js:88` — `seedTodos` createdAt = `meeting.started_at` (not `now()`). Long transcription queues no longer drag action items onto "today" in the timeline.
- [x] `src/voice/meeting-manager.js:73-82` — fail-loud `.catch` on `finalize` escape: logs stack, flips `processing` → `transcription_failed` (only if still `processing`), re-throws so `done` awaiters still see rejection. Resolves "stuck Processing card between restarts".
- [x] `src/pipeline/retry.js:73` — `seedTodos` createdAt = `meeting.started_at` (consistency with orchestrator path).
- [x] `src/web/api.js:231` — merge `seedTodos` createdAt = `target.started_at` (same alignment).
- [x] `web/src/pages/ActionItems.jsx:69-83` + `:124-127` — wrap toggle in try/catch; surface `toggleErr` banner. Non-admin 403 path now shows "Only admins can edit action items." instead of uncaught rejection.
- [x] `web/src/pages/Search.jsx:1` + `:8-23` — `Fragment` import added; `highlight` loops over all matches, not just first.
- [x] `src/store/db.js` + `src/pipeline/orchestrator.js` — atomically replace meeting utterances and persist transcript completeness; failed replacement rolls back without leaving a partial transcript.
- [x] `src/pipeline/retry.js` — retranscribe retained PCM for incomplete or legacy-unknown transcript state; known-complete transcripts still re-summarize without STT.
- [x] `docs/audit-2026-07-06.md` — reconcile audit #7 with the actual transactional persistence and PCM-aware retry fix.
- [x] Repository DB hygiene verified — `*.db`, `*.db-shm`, and `*.db-wal` are already ignored, and `git log --all -- meetings.db` is clean.

Verified: `npm test` 270/270 pass. `npm --prefix web run build` 64 modules, 282 kB bundle, clean. Sidecar: 10/10 pass (one known Starlette deprecation warning).

---

## Implemented in the fork

- [x] Persist Discord delivery status and errors. Admins can post saved notes from the meeting page.
- [x] Report delivery failures for dashboard retries and the delivery script.
- [x] Offer daily, opt-in retention and an admin preview over completed non-campaign meetings. SQLite reuses freed pages. Full scheduled VACUUM is deferred because it rewrites the database and requires extra disk space.
- [x] Reject missing sessions in the password-change guard and use server-side password length validation in onboarding.
- [x] Document the meeting ID invariant for action-item deduplication.
- [x] Let each free transcription worker take the next queued track without waiting for a specific worker.
- [x] Keep one pair of CLI recovery scripts. Direct users to the meeting page for recovery.
- [x] Reload meetings on route navigation and refresh the server list periodically and on window focus.
- [x] Distinguish loading and empty server lists, show an explicit empty meeting status, and add a show-everyone view in Analytics.
- [x] Render nested Markdown formatting in notes and answers.
- [x] Save new retained recordings as MP3 after transcription and preserve raw tracks when recovery may need them.

---

## Verification checklist (re-run before any PR)

- [x] `npm test` → 270/270 pass.
- [x] `npm --prefix web run build` → clean, 64 modules.
- [x] `stt_sidecar/.venv/bin/python -m pytest stt_sidecar/test_server.py -q` → 10/10 pass; one known Starlette deprecation warning.
- [ ] Manual smoke: start bot + sidecar, record a short meeting, confirm notes deliver; toggle an action item as admin (works) and as non-admin (403 + UI banner); retry a failed meeting from the dashboard.
