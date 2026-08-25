# Changelog

All notable changes to `agentbridge` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-08-26

Two further manual regression passes over `v1.0.0` (a targeted delta
check on the first fix below, then a full sweep adding permissions/
disk and Unicode/data-integrity categories that hadn't been covered
before) turned up five more findings - all fixed here.

### Fixed
- `agentbridge unlink --no-restore` printed "Successfully unlinked and
  restored." unconditionally - the same message as a normal unlink -
  even though `--no-restore` genuinely leaves the standalone folder
  empty. Found during a full v1.0.0 regression re-pass across all
  previously-fixed bugs plus every untested command/flag combination
  (65/65 checks). Now reports "Successfully unlinked." when nothing was
  restored.
- `agentbridge link-skills` was the only one of 5 mutating commands
  with no `try`/`catch` around its core call. A real filesystem error
  (an agent's skills directory existing as a plain file instead of a
  directory, or a read-only home directory) escaped uncaught past
  `@clack/prompts`' own exception monitor - printing a generic
  "Something went wrong" with no specifics, and never setting an exit
  code, so the process exited `0` despite the operation completely
  failing. Now reports the real error and exits `1`, matching every
  other mutating command.
- `status`'s "Local Skills" count included any subdirectory under an
  agent's skills folder, even ones with no `SKILL.md` at all (a broken
  partial copy, a stray `.git`, an empty folder) - dead code in the
  counting logic incremented the count regardless of whether `SKILL.md`
  actually existed.
- `agentbridge doctor` (without `--fix`) never set a non-zero exit code
  when it found real issues - the text already said so correctly, but a
  script relying on the exit code (`agentbridge doctor && deploy`)
  would proceed past broken links, exposed secrets, or skill-name
  collisions anyway. `--fix` successfully resolving what it found still
  exits `0`.
- `agentbridge add-skill ""` (an empty name) silently fell back to a
  generic `unnamed-skill` directory while every confirmation message
  kept echoing back the original empty string. Now rejected outright
  with a clear error, consistent with how `add-skill` already refuses
  other invalid input (a colliding name, a path-traversal attempt).

## [1.0.0] - 2026-08-25

First release backed by a full manual end-to-end test pass (every CLI
command, every documented flag, and a set of realistic broken-input
scenarios a unit-test suite or a static security audit doesn't reach:
corrupt config files, concurrent-process lock contention, mid-write
interruption, malformed frontmatter). All 0.2.0 security-audit findings
(including the critical path-traversal fix) were already fixed before
this release - what's new here is a separate class of bug: **correctness
under a broken or contended input silently degrading to a false "success"
report instead of an honest failure**, found independently five times
across five different layers of the codebase in this pass.

### Fixed
- **`agentbridge watch`**: the debounced AGENTS.md resync discarded
  `syncProjectRules()`'s per-target result and unconditionally reported
  "✔ Auto-synchronized" - including when every target actually failed
  (e.g. another agentbridge command holding the shared lock). Live-
  reproduced: 3 of 4 rule targets silently kept stale content behind a
  green checkmark, in a long-running background command where a user has
  no reason to notice. Now reports a distinct partial-failure warning
  naming exactly which targets failed, and a separate error path exists
  for a genuine throw (previously completely unguarded and capable of
  silently killing the whole watch process).
- **`agentbridge sync-mcp`**: an agent's MCP config file with invalid
  JSON was silently treated as empty and overwritten with only the newly
  synced servers, reported as a plain success - the original content
  (backed up, but with no indication anything unusual happened) was
  discarded without a trace in the terminal output.
- **`agentbridge pick`/`import`**: a skill whose `SKILL.md` frontmatter
  block existed but failed to parse as YAML had it silently regenerated
  from scratch (losing any field beyond name/description), reported as
  a plain successful import.
- **`agentbridge rollback`**: restoring a nonexistent or corrupt snapshot
  ID already computed the specific reason correctly at the core-function
  level, but the CLI's failure branch only inspected an (empty, in this
  case) per-file list and never printed it - just a generic "failed or
  was incomplete." A CLI-level integration test now guards this boundary
  specifically, since a unit test on the core function alone can't catch
  a bug that lives in how the CLI aggregates its result.
- **`agentbridge pick`/`import`**: a `directory`-type skill whose
  sanitized name collided with an already-imported one was silently
  absorbed with no files touched, reported as "Imported" (the
  `markdown_file` branch already had this collision check from 0.2.0;
  the more common `directory` branch did not).
- **`agentbridge sync-rules --mode symlink`**: on Windows without
  Developer Mode/an elevated shell, a file-symlink attempt transparently
  falls back to a hardlink - but was reported identically to a genuine
  symlink ("Symlinked to source"), hiding a real staleness risk (a
  hardlink doesn't follow AGENTS.md being replaced via delete+rewrite,
  only edited in place). Now reported distinctly with the staleness
  caveat.
- **`agentbridge link-skills`**: two agents having a same-named skill
  folder with genuinely different content had the losing agent's version
  silently discarded during the hub merge, reported as a plain
  "Imported" for both. Identical content across agents (the common case)
  still merges silently, as intended - only a real content mismatch is
  now flagged.
- **`agentbridge link-skills --dry-run`** left a stray empty hub
  directory behind despite promising not to write to disk.
- **`agentbridge sync-rules --cwd <path>`** silently created an entire
  new project directory tree (a fresh `AGENTS.md` plus every target
  file) when pointed at a path that didn't exist, instead of erroring -
  a typo'd `--cwd` would leave the real project's rules untouched with
  no warning that anything was wrong.
- `agentbridge link-skills` no longer crashes when an agent's skills
  directory is a broken (orphaned-target) junction/symlink - treated the
  same as "nothing to merge" instead.
- Backup snapshots created by the test suite are isolated from
  `~/.agentbridge/backups` via `AGENTBRIDGE_BACKUPS_DIR`, instead of
  leaving real snapshot files in a developer's actual home directory on
  every `npm test` run.
- README accuracy pass: architecture diagram and the `sync-rules`
  description now match actual behavior.

### Changed
- Version bump only; no dependency or build-tooling changes.

## [0.2.0] - 2026-08-25

### Security
- **Critical**: `agentbridge pick`/`import` no longer permits path traversal via an untrusted skill name. A skill's `SKILL.md` YAML frontmatter `name:` field had no format restriction and was joined directly into a filesystem path, so a crafted skill package (e.g. `name: ../../../../.ssh/authorized_keys`) could write attacker-controlled content outside the intended target directory. Fixed via `sanitizeSkillDirName()` + a resolved-path boundary check, reused by `createNewSkill()` as well.
- Resolved MCP server secrets (API keys, tokens) are now redacted back to `${VAR}` placeholders before being written to disk (`mcp_servers.json`, per-agent configs, `--output` exports), instead of persisting the resolved plaintext value.
- Written config, backup snapshot, and lockfiles are now restricted to `0600` instead of inheriting the platform default (previously world-readable on a shared POSIX machine).
- Guarded against a `__proto__`-named MCP server entry reassigning the merged config object's own prototype during config merging (bounded impact, but closed before any future deep-merge refactor could make it worse).
- Widened the doctor's plaintext-secret detector to catch AWS, Google, Slack, JWT, and npm token formats it previously missed, while adding a field-name-aware exception so a git commit SHA isn't misflagged as a secret.
- `agentbridge pick`/`import` no longer silently overwrites an existing skill's `SKILL.md` when a sanitized name collides with one already imported (common when the same skill exists in more than one agent's directory); it's skipped and reported unless `overwrite` is explicitly requested. `agentbridge add-skill` gets the same protection against overwriting an existing skill.

### Fixed
- Every agent-config writer (CLI commands, not just the `watch` daemon) now serializes through a single shared lockfile, and retries for a few seconds before reporting a clear failure instead of silently doing nothing when another `agentbridge` process briefly holds the lock.
- `pruneBackupSnapshots()` and `createBackupSnapshot()` are now race-free against a concurrent `watch` cycle; a failed rollback-of-a-rollback is now surfaced instead of swallowed.
- Relative-target symlinks (common on POSIX) are resolved against the link's own directory instead of the process's working directory, fixing false "not linked"/"broken link" reports.
- `isProcessAlive()` now distinguishes a genuinely dead process from one that's merely unreachable, instead of treating any unexpected error as "dead" and risking clearing a still-valid lock.

### Changed
- `.github/workflows/ci.yml`: GitHub Actions pinned to a commit SHA instead of a mutable version tag.
- Test suite runs sequentially (`vitest` `fileParallelism: false`) now that several tests exercise the shared production lockfile directly.

## [0.1.0] - 2026-08-25

### Added
- **Core Detection Engine** (`src/core/detector.ts`):
  - Support for 4 core AI coding agents: Google Antigravity, Claude Code, OpenAI Codex, and Cursor.
  - Automatic detection of custom command directories (e.g. `~/.claude/commands`) and system containers (e.g. `~/.codex/skills/.system`).
- **Skill Linking & Discovery** (`src/core/skill-linker.ts`):
  - Cross-platform zero-privilege NTFS Directory Junctions on Windows and POSIX symlinks on macOS/Linux.
  - Zero-loss skill merging into single source of truth at `~/.agentbridge/skills/`.
  - Skill collision detection across agents.
  - Clean unlinking with `agentbridge unlink`.
- **MCP Synchronizer** (`src/core/mcp-sync.ts`):
  - Deep-merging of environment variables, arguments, and servers across `mcpServers` dicts.
  - Automatic persistence to master registry `~/.agentbridge/mcp_servers.json`.
  - Support for environment variable interpolation (`${VAR}`).
- **Rule Consolidator** (`src/core/rules.ts`):
  - Single source-of-truth `AGENTS.md` consolidated to `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.
- **Doctor & Security Diagnostics** (`src/core/doctor.ts`):
  - Secret scanning for plaintext API tokens (`ghp_`, `sk-`, embedded DB passwords).
  - Cross-platform junction capability tests.
  - Automatic repair with `agentbridge doctor --fix`.
- **Backup & Rollback** (`src/core/rollback.ts`):
  - Timestamped snapshot creation and restoration via `agentbridge rollback`.
- **Real-Time Watcher** (`src/core/watcher.ts`):
  - Live auto-sync daemon with `agentbridge watch`.
- **Antigravity Skill**:
  - Native Antigravity Skill integration at `~/.gemini/config/skills/agentbridge/SKILL.md`.
- **CI/CD**:
  - Multi-OS matrix testing (Ubuntu, macOS, Windows on Node.js 18, 20, 22).

