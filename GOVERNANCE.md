# Governance

Three Studio is a small, maintainer-led open-source project. This document
explains how decisions are made and what contributors can expect.

## Model

- **Benevolent dictator for life (BDFL):** the project maintainer has the final
  say on scope, releases and disputes. The current maintainer is listed in
  `CODEOWNERS`.
- **Core is permanently Apache-2.0.** Code accepted into the core will not be
  relicensed to a source-available or proprietary license.
- **Commercial services are separate.** Hosted sharing, team collaboration,
  enterprise administration and managed model access may live in separate
  proprietary repositories or services. The core must remain useful without
  them.

## Decisions

- Small changes: pull request review by a code owner.
- User-visible or architectural changes: open an issue first and describe the
  problem, alternatives and security impact.
- Security-sensitive changes (sandbox, credentials, API routes, plugin
  boundaries): require explicit review from a code owner and a regression test.
- Disagreements are resolved by the BDFL after a public discussion. Decisions
  are recorded in the pull request or issue rather than in private chat.

## Contributions

- Every commit must carry a `Signed-off-by` line under the Developer
  Certificate of Origin 1.1 (DCO). We do not require a CLA for the core.
- Contributors retain copyright. By signing off, you certify that you wrote the
  contribution or have the right to submit it under Apache-2.0.
- AI-assisted contributions are welcome when disclosed in the pull request. The
  contributor remains responsible for the result, its licensing and its tests.

## Releases

- Before 1.0, minor releases may include breaking changes with migration notes.
- After 1.0, semantic versioning applies.
- Security fixes are released as patches as soon as a fix is verified.
- Release artifacts should include a signed tag, checksums and an SBOM once the
  release workflow is automated.

## Security

Report vulnerabilities through a private GitHub Security Advisory, not a public
issue. See `SECURITY.md` for scope and response expectations.

## Changes to this document

Governance changes require a public pull request and a comment period of at
least seven days. The core Apache-2.0 commitment cannot be weakened by a
governance change.
