# Auto-Apply Improvements — Design / Spec (2026-06-14)

Goal: make the open-source `auto-apply` engine **easy to use, efficient, and stable** for any
job seeker driving it with Claude Code (or a similar agent), and bring it to **full feature
parity** with the private `mundi-auto-apply` project from which it was generalized. Every mundi
helper is ported (generalized, person-agnostic) and wired in so it is actually usable, unless
there is a very good reason to exclude it.

No changes are made to `mundi-auto-apply` — it is read-only reference.

## A. Claude Code native layer (`.claude/`)
- `.claude/skills/playwright-cli/` — vendor the full playwright-cli skill (SKILL.md + references),
  generic content only. The whole pipeline is built on `playwright-cli` (`@playwright/cli`).
- `.claude/commands/apply.md`, `day-review.md`, `pre-answer.md` — slash commands, generalized
  (profile.yaml-driven, `src/` paths, no personal data).
- `.claude/settings.json` — permission allowlist pre-approving the safe hot path so users are not
  prompted on every `node`/`python3`/`playwright-cli`/`bash scripts/*` call.

## B. `playwright-cli` documented + installable
README requirements + quick start cover it; `@playwright/cli` added to `devDependencies` so
`npx playwright-cli` works after `npm install`; global install documented as the alternative.

## C. First-run scaffolding
- `applications/.gitkeep`, `applications/_resumes/.gitkeep`.
- Committed starter resume `config/resume-base.example.md` (fictional, matches profile.example).
- `bin/init.mjs` scaffolds `applications/_resumes/` and copies the starter resume +
  `config/manual-apply.example.yaml` if absent.

## D. Local-laptop-first browser path
- `scripts/start-chrome.sh` — headed Chrome + CDP + persistent profile for macOS and local Linux.
- `vps-up.sh` / `start-chrome-linux.sh` remain for the headless scale-up.
- README leads with the local path; `npm run browser` targets local.

## E. Preflight doctor
- `bin/doctor.mjs` (`npm run doctor`) — ✓/✗ checklist (Node, Python, Chrome, playwright-cli,
  Playwright chromium, profile present + rules fresh, resume exists, applications/ present,
  email-imap optional), each failure with a one-line fix.

## F. Stability
- `src/lib/csv.mjs` — correct CSV parse/write (quoted fields, embedded commas, header-indexed);
  `src/next-jobs.mjs` refactored to use it.
- Tests via `node:test` (`npm test`): check-email-code (`normalizeBody`/`extractCode`),
  build-rules smoke, csv round-trip; plus python `test/test-scan-followups.py`.

## G. Full mundi feature port (generalized, wired in)
- Discovery scale: `src/sync-jobhive.mjs`, `src/discover-jobhive.py` (duckdb dataset),
  `src/harvest-tokens.mjs` (`--extract`/`--names`), `scripts/sweep-universe.sh`,
  `config/companies-universe.example.json`.
- Email gates: `src/get-code-by-subject.mjs`, `src/retry-email-run.mjs`
  (config/email-imap.json).
- Outcome tracking: `src/scan-followups.py` (deps-free, print-only digest, writes
  `followup_status`) + `test/test-scan-followups.py`.
- Orchestration: `scripts/batch-loop.sh`, `scripts/run-nightly.sh`,
  `scripts/worker-browser.sh` (parallel isolated workers).
- Knowledge: generalized `LEARNINGS.md` (person-agnostic ATS quirks) + `GUIDE.md`
  (human walkthrough). `config/manual-apply.example.yaml`, `config/queue.example.yaml`.

## H. Docs
README rewritten (local-first, full feature set, correct requirements, corrected layout);
CLAUDE.template touched up to reference the new commands/scripts/features.

## Excluded (with reason)
- `scripts/legacy/*` — superseded one-off fillers; replaced by the generalized filler.template.js.
- `config/targets.yaml`, `profile/qa-map.yaml`, `profile/facts.md` — superseded by the unified
  `config/profile.yaml` + generated `rules.json` model auto-apply already uses.
- `HERMES.md`, `.hermes/`, Telegram/Hermes coupling — personal notification infra; the value is
  preserved via `scan-followups.py` print-only output + a documented cron.
- `OPTIMIZATIONS.md`, `SESSION-*.md` — historical/ephemeral mundi records.
- mundi's harvested `companies-universe.json` (~18k slugs) — large third-party-derived dataset
  (CC BY-NC). Ship the tooling to build/refresh it (`sync-jobhive`, `harvest-tokens`,
  `sweep-universe`) + a tiny example instead; the rotation feature itself is preserved.
- `profile/voice-guide.md` — folded into the `voice:` block of `config/profile.yaml`.

## Execution
Workflow A ports the independent leaf files in parallel (read mundi, write generalized into
auto-apply). Integration of cross-cutting files (package.json, README, CLAUDE.template,
init.mjs, .gitignore) is authored centrally for coherence. Workflow B verifies: syntax checks,
personal-data leak scan, `npm test`, `npm run doctor`, and a consistency/generalization review.
