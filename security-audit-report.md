# Security Audit Report

**Project**: agentsync (connector)
**Date**: 2026-08-25
**Auditor**: Claude Security Audit
**Frameworks**: OWASP Top 10:2025 + NIST CSF 2.0
**Mode**: full

---

## Executive Summary

**Architecture note (read first)**: agentsync is a local Node.js CLI tool (commander-based) that reads and writes configuration files on the user's own machine (skill directories, MCP server JSON configs, project rule files for 4 supported AI coding agents). It has **no web server, no HTTP/API surface, no database, no authentication/session system, and makes no outbound network calls**. Most of the standard OWASP Top 10:2025 web-application categories (XSS, CSRF, SSRF, SQL/NoSQL injection, API rate limiting, WebSocket/gRPC/Serverless, OAuth/Passkeys) are **not applicable** to this architecture and are marked as such below rather than padded with speculative findings. The relevant attack surface is: untrusted file content the tool parses (skill packages, other agents' config files) and filesystem writes it performs based on that content.

| Metric | Count |
|--------|-------|
| 🔴 Critical | 1 |
| 🟠 High | 0 |
| 🟡 Medium | 1 |
| 🟢 Low | 3 |
| 🔵 Informational | 3 |
| 🔲 Gray-box findings | 0 (N/A — no roles/auth boundaries exist to test) |
| 📍 Security hotspots | 5 |
| 🧹 Code smells | 3 |
| **Total findings** | **8** |

**Overall Risk Assessment**: One critical, concretely exploitable path-traversal write bug in the skill-import flow needs an immediate fix. Everything else found is narrow-impact or defense-in-depth. The codebase's recent work (this session, prior to this audit) already closed out secrets-in-plaintext, file-permission, and lock/concurrency issues that would otherwise have shown up here — that hardening is reflected as informational notes, not re-litigated as new findings.

---

## OWASP Top 10:2025 Coverage

| OWASP ID | Category | Findings | Status |
|----------|----------|----------|--------|
| A01:2025 | Broken Access Control | 1 | 🔴 Needs Attention |
| A02:2025 | Security Misconfiguration | 0 | ✅ Acceptable |
| A03:2025 | Software Supply Chain Failures | 2 | 🟢 Low-risk items only |
| A04:2025 | Cryptographic Failures | 0 | ✅ Acceptable (no crypto in scope; secrets handling already hardened) |
| A05:2025 | Injection | 0 | ✅ Acceptable (no SQL/command/template injection surface) |
| A06:2025 | Insecure Design | 0 | ✅ Acceptable |
| A07:2025 | Authentication Failures | N/A | N/A — no authentication system exists |
| A08:2025 | Software or Data Integrity Failures | 1 | 🟡 Needs Attention |
| A09:2025 | Security Logging and Alerting Failures | 0 | ✅ Acceptable for a local CLI (no security-relevant events to alert on) |
| A10:2025 | Mishandling of Exceptional Conditions | 0 | ✅ Acceptable (fail-open lock bug already fixed prior to this audit) |

---

## NIST CSF 2.0 Coverage

| Function | Categories | Findings | Status |
|----------|-----------|----------|--------|
| GV (Govern) | GV.SC | 2 | 🟢 Low-risk items only |
| ID (Identify) | ID.AM | 0 | ✅ Acceptable |
| PR (Protect) | PR.AA, PR.DS | 2 | 🔴 Needs Attention (PR.AA — the path traversal) |
| DE (Detect) | DE.CM, DE.AE | 0 | ✅ Acceptable |
| RS (Respond) | — | 0 | N/A |
| RC (Recover) | — | 0 | N/A |

---

## Compliance Coverage

| Framework | Coverage | Details |
|-----------|----------|---------|
| CWE | 3 unique CWEs identified | CWE-22 (Path Traversal), CWE-1321 (Prototype Pollution), CWE-1104 (Unmaintained/advisory transitive component) |
| SANS/CWE Top 25 | 1/25 entries found | #5 Path Traversal (CWE-22) |
| OWASP ASVS 5.0 | 2/14 chapters with findings | V4 (Access Control), V12 (Files and Resources) |
| PCI DSS 4.0.1 | Not applicable | Tool does not process payment card data |
| MITRE ATT&CK | 1 technique mapped | T1005-adjacent local file write via T1190-class input handling (no formal ATT&CK ID for local-tool path traversal outside a network-facing app; noted qualitatively) |
| SOC 2 | 1 criteria with findings | CC6.6 (System Boundary Protection — file write boundary) |
| ISO 27001:2022 | 2 controls with findings | A.8.26 (Application Security Requirements), A.8.28 (Secure Coding) |

---

## 🔴 Critical Findings

### 🔴 [CRITICAL-001] Path traversal via attacker-controlled skill name in `agentsync pick`/`import`

- **Severity**: 🔴 CRITICAL
- **OWASP**: A01:2025 (Broken Access Control)
- **CWE**: CWE-22 (Path Traversal)
- **NIST CSF**: PR.AA (Protect — Access Control)
- **Compliance**: SANS/CWE Top 25 #5 | ASVS V4.1.3 / V12.3.1 | ATT&CK T1005 (local system data manipulation via malicious input) | SOC 2 CC6.6 | ISO 27001 A.8.26, A.8.28
- **Location**: `src/core/skill-linker.ts:439` (the vulnerable write), with the tainted value originating at `src/core/skill-linker.ts:92` (`readSkillDirectory`) and flowing unchecked through `discoverAllAvailableSkills` (`src/core/skill-linker.ts:365-390`) and `src/utils/schema.ts` (`SkillFrontmatterSchema.name: z.string().optional()` — no format restriction)

**Attack Vector**:
1. `agentsync pick` (aliased `import`) calls `discoverAllAvailableSkills()`, which scans every configured agent's skill directory (`~/.claude/skills`, `~/.cursor/skills`, `~/.codex/skills`, `~/.gemini/config/skills`) plus `~/.claude/commands`, and for every skill directory found, reads `SKILL.md` and parses its YAML frontmatter.
2. `readSkillDirectory()` sets `name: frontmatter.name || dirName` (`skill-linker.ts:92`) — if the SKILL.md's frontmatter contains a `name:` field, that value is used verbatim as the skill's `DiscoveredSkill.name`, with **no character/format restriction**. `SkillFrontmatterSchema` (`schema.ts`) only requires `name` to be *some* string; `validateSkillFrontmatter()`'s pass/fail result is not even consulted before this value is used.
3. The user runs `agentsync pick`, is shown a multiselect list built from these names, and selects the (attacker-crafted) skill to import.
4. `selectivelyImportSkills()` computes `const destDir = path.join(absTarget, skill.name);` (`skill-linker.ts:439`) with **no sanitization**. `path.join()` normalizes `..` segments but does **not** prevent the result from escaping `absTarget` — `path.join('/home/user/.agentsync/skills', '../../../.ssh/authorized_keys')` resolves outside the hub directory.
5. For a directory-type skill, `copyDirRecursive(skill.sourcePath, destDir, options.overwrite)` (`skill-linker.ts:442`) recursively copies the entire attacker-supplied skill folder to that traversed path. For a markdown-file-type skill, `fsp.writeFile(path.join(destDir, 'SKILL.md'), finalContent, 'utf-8')` (`skill-linker.ts:459`) writes attacker-controlled content directly.

A malicious skill package — the exact kind of artifact this tool is designed to import from a shared/community source — needs only a crafted `name:` field in its `SKILL.md` frontmatter, e.g.:
```yaml
---
name: ../../../../.ssh/authorized_keys
description: Looks harmless in the picker
---
```
to write attacker-controlled content to any path the current OS user can write to.

**Impact**: Arbitrary file write, with attacker-chosen content, to any location the invoking user has write permission for. This is a well-established path to code execution (overwriting a shell profile — `.bashrc`/`.zshrc`/PowerShell profile — to run on the user's next shell session, or an SSH `authorized_keys` file for persistence), or to corrupting the *other* AI agents' real configuration files this tool is trusted to manage. The only user interaction required is running `agentsync pick` and selecting the malicious entry from a list — no elevated privileges are needed beyond what the user already has.

**Vulnerable Code** (`src/core/skill-linker.ts`):
```ts
// line 92, inside readSkillDirectory():
return {
  name: frontmatter.name || dirName,   // frontmatter.name is unrestricted attacker input
  ...
};

// line 439, inside selectivelyImportSkills():
const destDir = path.join(absTarget, skill.name);   // no sanitization before path.join
```

**Remediation**: Sanitize `skill.name` before it is ever used as a filesystem path segment — the same way `createNewSkill()` already does for user-typed skill names (`skill-linker.ts:284-287`, `.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-')`). Apply an equivalent allowlist sanitization at the point `DiscoveredSkill.name` is constructed from frontmatter (or, as defense in depth, immediately before the `path.join()` in `selectivelyImportSkills()`), and additionally assert `path.resolve(destDir).startsWith(absTarget + path.sep)` before any write, rejecting the import with a clear error if it does not.

---

## 🟡 Medium Findings

### 🟡 [MEDIUM-001] Unsanitized object keys from parsed JSON used in bracket assignment (prototype-pollution-adjacent)

- **Severity**: 🟡 MEDIUM
- **OWASP**: A08:2025 (Software or Data Integrity Failures)
- **CWE**: CWE-1321 (Improperly Controlled Modification of Object Prototype Attributes) / CWE-915 (Improperly Controlled Modification of Dynamically-Determined Object Attributes)
- **NIST CSF**: PR.DS (Protect — Data Security)
- **Compliance**: ASVS V5.2.3 (untrusted data structure handling) | ISO 27001 A.8.28
- **Location**: `src/core/mcp-sync.ts:106-107, 129-130, 132, 206, 209`

**Attack Vector**: `collectMcpServers()` and `syncMcpConfigs()` read each configured agent's MCP config file via `safeReadJson()` (a thin `JSON.parse()` wrapper) and iterate `Object.entries(fileContent.mcpServers)`, then assign into a plain object literal with `mergedServers[name] = ...` / `newServers[name] = ...`, where `name` is a runtime string taken directly from the parsed JSON's keys. If any of the 4 agent config files (or the master hub file) contains an MCP server entry literally named `"__proto__"` — plausible, since MCP server entries are routinely added by pasting JSON snippets from READMEs/marketplaces into these exact files — the bracket assignment invokes the `Object.prototype.__proto__` accessor and reassigns that *specific local object's* own prototype to the attacker-supplied value.

**Impact**: Bounded, not a full global `Object.prototype` pollution — object-literal spread (`{...config}`, used elsewhere for copying config *values*) is not affected, and `JSON.stringify()` (used when writing results back to disk) only serializes own enumerable properties, so the corrupted prototype does not propagate into files this tool writes. The practical impact is corrupted property resolution on the in-memory `mergedServers`/`newServers` object for the remainder of that command's execution (e.g. unexpected inherited properties appearing on property access), which could cause incorrect merge results or a crash, rather than arbitrary code execution. Still a real defect worth closing defensively, and the exact pattern (`obj[untrustedKey] = value`) is the textbook precursor to prototype pollution if this code is ever refactored to a deeper recursive merge.

**Remediation**: Reject or skip entries whose key is `__proto__`, `constructor`, or `prototype` before the assignment (a one-line guard at the top of each loop body), or construct `mergedServers`/`newServers` with `Object.create(null)` instead of `{}` so the `__proto__` accessor doesn't exist to be triggered, or use a `Map<string, MCPServerConfig>` instead of a plain object for these intermediate structures.

---

## 🟢 Low Findings

### 🟢 [LOW-001] Transitive devDependency has a known low-severity advisory

- **Severity**: 🟢 LOW
- **OWASP**: A03:2025 (Software Supply Chain Failures)
- **CWE**: CWE-1104 (Use of Unmaintained Third-Party Components, pinned-range advisory)
- **NIST CSF**: GV.SC (Govern — Supply Chain Risk Management)
- **Location**: `esbuild` 0.27.3–0.28.0, transitive via `tsup` (devDependency only)

`npm audit` reports [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr): esbuild's development server allows arbitrary file read on Windows when its `--serve` mode is running and reachable. `npm audit` itself rates this **low severity**. This project never invokes esbuild's serve mode (`tsup --watch` recompiles on change; it does not open a network-reachable dev server), so it is not exploitable in this project's actual usage, and it is devDependency-only (not shipped in the published package). Confirmed via `npm audit`: 0 vulnerabilities in production dependencies, 1 low in devDependencies.

**Remediation**: `npm audit fix` (or bump `tsup` to a version pulling a patched `esbuild`) when convenient; not urgent given the non-exploitable usage pattern here.

### 🟢 [LOW-002] GitHub Actions pinned to major-version tags, not commit SHAs

- **Severity**: 🟢 LOW
- **OWASP**: A03:2025 (Software Supply Chain Failures)
- **CWE**: CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)
- **NIST CSF**: GV.SC
- **Location**: `.github/workflows/ci.yml:21,24` (`actions/checkout@v4`, `actions/setup-node@v4`)

Both actions are pinned to a mutable major-version tag rather than a commit SHA. If either action's `v4` tag were ever repointed (compromised maintainer account, compromised publishing pipeline), CI would silently pull the new code. Low severity here specifically because this workflow handles no secrets and runs no publish/deploy step (confirmed by reading the full workflow) — the blast radius of a compromised action in this pipeline is limited to the ephemeral test runner.

**Remediation**: Pin to a full commit SHA (e.g. `actions/checkout@<sha> # v4.x.x`) if/when this pipeline gains a publish step or any secret access.

### 🟢 [LOW-003] TOCTOU race in symlink/junction check-then-act flow

- **Severity**: 🟢 LOW
- **OWASP**: A06:2025 (Insecure Design)
- **CWE**: CWE-367 (Time-of-check Time-of-use Race Condition)
- **NIST CSF**: PR.PS
- **Location**: `src/utils/fs.ts` — `createCrossPlatformLink()`, the `pathExists(absLink)` / `isSymlinkOrJunction(absLink)` checks followed later by `removeLinkOrDir()` and `fsp.symlink()`

There's a window between checking whether a link target exists/what it is and acting on that check (removing it, then creating a new link). On a genuinely single-user local machine this is very low risk (would require another process racing the exact same path at the exact same moment), and is a pre-existing pattern, not something introduced recently. Noted for completeness since a symlink race in principle can be used to redirect a privileged write, though there is no privilege boundary being crossed here (the tool only ever operates within the invoking user's own permissions).

**Remediation**: Not urgent for a single-user local tool. If hardened further, use `fsp.symlink()`'s own atomic failure (`EEXIST`) as the source of truth instead of a separate pre-check, retrying only on that specific error.

---

## 🔵 Informational Findings

### 🔵 [INFO-001] Secrets, file permissions, and lock-contention handling already hardened

Prior to this audit (same session), the following were already fixed and verified with passing tests + CI across all 9 OS/Node combinations: resolved MCP secrets are redacted back to `${VAR}` placeholders before being written to disk (`utils/schema.ts` `redactEnvValue`/`redactEnvRecord`); written config/backup/lock files are restricted to `0600`; all agent-config writers share a single lockfile with retry-then-clear-failure semantics instead of silently no-op'ing when contended. No action needed — noted here so this audit isn't read as having missed that surface.

### 🔵 [INFO-002] No authentication/authorization system — A07:2025 and gray-box testing are not applicable

This is a single-user local CLI with no concept of accounts, roles, sessions, or tokens. Phase 3 (Gray-Box Testing) checklist items (role-based access, session boundaries, rate limits) do not apply to this architecture and are omitted rather than forced.

### 🔵 [INFO-003] `package.json` repository URL does not match the actual git remote

`package.json`'s `repository.url` / `homepage` point to `github.com/agentsync-dev/agentsync`, while the actual configured git remote is `github.com/Helter5/agentsync`. Not a security issue by itself, but worth fixing so anyone consulting the published npm metadata for the canonical source (e.g. verifying provenance before installing) lands in the right place.

---

## 📍 Security Hotspots

### [HOTSPOT-001] MCP config merge/write pipeline
- **OWASP**: A08:2025 | **CWE**: CWE-915 | **NIST CSF**: PR.DS
- **Location**: `src/core/mcp-sync.ts` (`collectMcpServers`, `mergeServerConfig`, `syncMcpConfigs`)
- **Why sensitive**: This is the trust boundary where content from 4 separately-owned config files (each potentially edited by a different AI agent's own tooling, or by a user pasting a marketplace snippet) is merged and written back out across all of them. It's also where [MEDIUM-001] lives.
- **Risk if modified**: A future change that introduces a deeper/recursive merge here (instead of the current shallow spread-based merge) would turn [MEDIUM-001] from bounded into full prototype pollution risk.
- **Review guidance**: Any PR touching this file should be checked for new `obj[key] = value` patterns with a JSON-sourced `key`, and for any move from shallow to deep merging.

### [HOTSPOT-002] Skill frontmatter parsing and import
- **OWASP**: A01:2025, A08:2025 | **CWE**: CWE-22 | **NIST CSF**: PR.AA
- **Location**: `src/utils/schema.ts` (`parseFrontmatter`), `src/core/skill-linker.ts` (`readSkillDirectory`, `discoverAllAvailableSkills`, `selectivelyImportSkills`)
- **Why sensitive**: This is where [CRITICAL-001] lives, and more generally the boundary where arbitrary, potentially-shared skill content becomes filesystem paths and file contents.
- **Risk if modified**: Any new code path that derives a destination path from a `SkillManifest`/`DiscoveredSkill` field without going through the sanitizer added to fix [CRITICAL-001] reintroduces the same class of bug.
- **Review guidance**: Treat every field of a parsed `SkillFrontmatter` as untrusted user input, not as internal metadata.

### [HOTSPOT-003] Cross-platform symlink/junction creation
- **OWASP**: A06:2025 | **CWE**: CWE-367 | **NIST CSF**: PR.PS
- **Location**: `src/utils/fs.ts` (`createCrossPlatformLink`, `removeLinkOrDir`, `isSymlinkOrJunction`, `readLinkTarget`)
- **Why sensitive**: Divergent Windows-junction vs. POSIX-symlink semantics, [LOW-003]'s TOCTOU window, and this is the code that decides what an agent's skills directory actually points to.
- **Risk if modified**: A subtle platform-conditional bug here silently breaks skill sync for one OS without the others' tests catching it (mitigated somewhat by this project's `windows-latest`/`macos-latest`/`ubuntu-latest` CI matrix).

### [HOTSPOT-004] Shared lockfile mechanism
- **OWASP**: A06:2025 | **CWE**: CWE-362 | **NIST CSF**: PR.PS
- **Location**: `src/utils/fs.ts` (`acquireLock`, `withLock`, `isProcessAlive`)
- **Why sensitive**: Every agent-config write in the tool now depends on this being correct (recently expanded in scope this session). A regression here silently reintroduces either data races or false "another process is running" failures across every write path.
- **Risk if modified**: High blast radius for a small function — a bug here affects `sync-mcp`, `sync-rules`, `add-skill`, `pick`, and `rollback` simultaneously.

### [HOTSPOT-005] Backup snapshot restore
- **OWASP**: A08:2025 | **CWE**: CWE-502-adjacent (trusted deserialization of local state, not remote) | **NIST CSF**: PR.DS
- **Location**: `src/core/rollback.ts` (`restoreBackupSnapshot`)
- **Why sensitive**: Reads a JSON snapshot file from `~/.agentsync/backups/` and writes its `files` map's contents back to the *original* absolute paths verbatim, with no validation that those paths are still the ones the snapshot was meant for. The snapshot files are now `0600` (this session), narrowing who could tamper with them to the same OS user, but the restore logic itself still trusts the file's contents completely.
- **Review guidance**: If snapshot files are ever handled with less restrictive permissions in the future (e.g. a "shared backups" feature), this function needs integrity validation before restore.

---

## 🧹 Code Smells

### [SMELL-001] Unused import
- **OWASP**: A06:2025 | **CWE**: — | **NIST CSF**: GV.RM
- **Location**: `src/core/rules.ts:6` — `readLinkTarget` is imported but never used in the file.
- **Pattern**: Dead import.
- **Security implication**: None directly; flagged because unused imports in security-relevant files make it harder to tell at a glance what a module's actual dependencies/trust boundaries are.
- **Suggestion**: Remove the unused import.

### [SMELL-002] Widespread empty `catch {}` blocks with no logging
- **OWASP**: A10:2025 | **CWE**: CWE-390, CWE-392 | **NIST CSF**: DE.AE
- **Location**: Pervasive across `src/utils/fs.ts` (e.g. `pathExists`, `pathExistsSync`, `isSymlinkOrJunction`, `readLinkTarget`, `removeLinkOrDir`'s `ENOENT` swallow) and `src/core/skill-linker.ts` (`readSkillDirectory`'s outer `catch { return null; }`)
- **Pattern**: Many functions use `try { ... } catch { return false/null; }` with zero logging of *why* the operation failed.
- **Security implication**: Mostly appropriate here (these are "does this exist / is this a link" probes where "no" and "error" are meant to collapse to the same answer), but it means a permissions error, a corrupted file, and a genuinely-missing file are all indistinguishable to the user — which makes diagnosing a security-relevant failure (e.g. "why didn't my skill import?") harder than it needs to be.
- **Suggestion**: Not a blanket fix — most of these are fine as designed. Worth revisiting only for the outer catches in higher-level operations (`readSkillDirectory`, `createCrossPlatformLink`'s outer catch) where surfacing the real error to the CLI user would aid troubleshooting without changing behavior.

### [SMELL-003] `package.json` metadata drift from actual repository
- **OWASP**: A03:2025 | **CWE**: — | **NIST CSF**: GV.SC
- **Location**: `package.json:35-39`
- See [INFO-003] above — same finding, listed here for the Code Smells category per the report template.

---

## Recommendations Summary

1. **Fix [CRITICAL-001] before the next release.** Sanitize skill names the same way `createNewSkill()` already does, and add a `path.resolve(...).startsWith(...)` boundary check as defense in depth in `selectivelyImportSkills()`.
2. **Fix [MEDIUM-001]** with a one-line `__proto__`/`constructor`/`prototype` key guard in the three `mcp-sync.ts` merge loops — cheap, low-risk, closes off the pattern before any future refactor makes it worse.
3. The three LOW findings are housekeeping — address opportunistically, none are urgent.
4. No changes needed for A02, A04, A05, A06 (beyond MEDIUM-001), A07 (N/A), A09 — this audit did not find issues there and is not fabricating any to fill out the template.

---

## Methodology

| Aspect | Details |
|--------|---------|
| Phases executed | 1–5 (full) |
| Frameworks detected | None of the listed web frameworks (Laravel/Next.js/FastAPI/Express/Django/Rails/Spring Boot/ASP.NET/Go/Flask) apply — this is a framework-less Node.js CLI built on `commander` |
| White-box categories | All 20 categories reviewed; 8 marked not applicable to this architecture (XSS, CSRF, File Upload & Storage as a web concept, API Security, Business Logic Flaws as a web concept, WebSocket, gRPC, Serverless/Cloud-Native) and noted as such rather than skipped silently |
| Gray-box testing | Not applicable — no roles, sessions, or auth boundaries exist (see INFO-002) |
| Security hotspots | 5 identified across the MCP merge pipeline, skill import pipeline, symlink handling, lockfile mechanism, and backup restore |
| Code smells | 3 identified (structural: 1, error handling: 1, dependency metadata: 1) |
| Packs loaded | none |
| Scope exclusions | no (`.security-audit-ignore` not present) |
| Baseline comparison | no (`.security-audit-baseline.json` not present) |
| OWASP Top 10:2025 | 10/10 categories evaluated (1 marked N/A: A07) |
| NIST CSF 2.0 | GV, ID, PR, DE functions evaluated; RS/RC not applicable (no incident-response surface in a local CLI) |
| CWE | 3 unique CWE IDs identified (CWE-22, CWE-1321/CWE-915, CWE-1104), plus CWE-367 and CWE-390/392 in Low/Smells |
| SANS/CWE Top 25 | 1/25 matched (#5 Path Traversal) |
| ASVS 5.0 | V4, V5, V12 referenced |
| Additional frameworks | PCI DSS 4.0.1 (not applicable — no payment data), MITRE ATT&CK, SOC 2, ISO 27001:2022 |
| Dependency audit | `npm audit`: 0 vulnerabilities in production dependencies; 1 low-severity in devDependencies (esbuild, transitive via tsup) |
| Git history secret scan | `git log -p --all -S` for common secret patterns across full history: no committed real secrets found (one match was the detector's own regex pattern string in source code, not a leaked credential) |

---

*Report generated by Claude Security Audit*
