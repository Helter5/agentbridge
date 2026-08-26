# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | ✅ |
| < 1.0.0 | ❌ |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/Helter5/agentbridge/security) of this repository.
2. Click **"Report a vulnerability"**.
3. Describe the issue, the affected version, and steps to reproduce if possible.

You should receive an initial response within a few days. If the report is confirmed, a fix will be prepared and a new patch release published, with credit given in the release notes (unless you prefer to stay anonymous).

## Audit History

AgentBridge has gone through multiple rounds of security and correctness review prior to `v1.0.0`/`v1.0.1`:

- 4 formal security audits (white-box + gray-box).
- 3 manual end-to-end regression passes across all commands and flag combinations.
- Automated test suite: 89/89 tests passing.
- CI: 9/9 checks passing.
- Latest manual regression pass: 69/69 checks passing.

Two low-severity findings remain intentionally unaddressed for the current single-user, local-tool threat model:

- **LOW-001** — an `esbuild` dev-dependency advisory (build-time only, not part of the shipped runtime).
- **LOW-003** — a TOCTOU (time-of-check to time-of-use) race in a filesystem check, judged low-impact for a tool that operates on the local user's own home directory.

Both were evaluated across multiple audit rounds and re-confirmed as non-urgent each time. They will be revisited if the threat model changes (e.g. multi-user or networked usage).
