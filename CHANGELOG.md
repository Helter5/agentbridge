# Changelog

All notable changes to `agentsync` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-25

### Security
- **Critical**: `agentsync pick`/`import` no longer permits path traversal via an untrusted skill name. A skill's `SKILL.md` YAML frontmatter `name:` field had no format restriction and was joined directly into a filesystem path, so a crafted skill package (e.g. `name: ../../../../.ssh/authorized_keys`) could write attacker-controlled content outside the intended target directory. Fixed via `sanitizeSkillDirName()` + a resolved-path boundary check, reused by `createNewSkill()` as well.
- Resolved MCP server secrets (API keys, tokens) are now redacted back to `${VAR}` placeholders before being written to disk (`mcp_servers.json`, per-agent configs, `--output` exports), instead of persisting the resolved plaintext value.
- Written config, backup snapshot, and lockfiles are now restricted to `0600` instead of inheriting the platform default (previously world-readable on a shared POSIX machine).
- Guarded against a `__proto__`-named MCP server entry reassigning the merged config object's own prototype during config merging (bounded impact, but closed before any future deep-merge refactor could make it worse).
- Widened the doctor's plaintext-secret detector to catch AWS, Google, Slack, JWT, and npm token formats it previously missed, while adding a field-name-aware exception so a git commit SHA isn't misflagged as a secret.

### Fixed
- Every agent-config writer (CLI commands, not just the `watch` daemon) now serializes through a single shared lockfile, and retries for a few seconds before reporting a clear failure instead of silently doing nothing when another `agentsync` process briefly holds the lock.
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
  - Zero-loss skill merging into single source of truth at `~/.agentsync/skills/`.
  - Skill collision detection across agents.
  - Clean unlinking with `agentsync unlink`.
- **MCP Synchronizer** (`src/core/mcp-sync.ts`):
  - Deep-merging of environment variables, arguments, and servers across `mcpServers` dicts.
  - Automatic persistence to master registry `~/.agentsync/mcp_servers.json`.
  - Support for environment variable interpolation (`${VAR}`).
- **Rule Consolidator** (`src/core/rules.ts`):
  - Single source-of-truth `AGENTS.md` consolidated to `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.
- **Doctor & Security Diagnostics** (`src/core/doctor.ts`):
  - Secret scanning for plaintext API tokens (`ghp_`, `sk-`, embedded DB passwords).
  - Cross-platform junction capability tests.
  - Automatic repair with `agentsync doctor --fix`.
- **Backup & Rollback** (`src/core/rollback.ts`):
  - Timestamped snapshot creation and restoration via `agentsync rollback`.
- **Real-Time Watcher** (`src/core/watcher.ts`):
  - Live auto-sync daemon with `agentsync watch`.
- **Antigravity Skill**:
  - Native Antigravity Skill integration at `~/.gemini/config/skills/agentsync/SKILL.md`.
- **CI/CD**:
  - Multi-OS matrix testing (Ubuntu, macOS, Windows on Node.js 18, 20, 22).

