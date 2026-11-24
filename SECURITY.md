# Security policy

Three Studio is a local, single-user developer tool. It binds loopback only and
has no account system.

## Reporting

Please report suspected vulnerabilities through a **private GitHub Security
Advisory** for this repository. Do not open a public issue with exploit details,
API keys, tokens or user session content.

Include:

- affected version or commit
- environment (OS, browser, standalone vs Harness plugin mode)
- reproduction steps and expected/actual behavior
- any relevant logs with secrets redacted

## Scope

In scope: scene sandbox escapes, XSS/HTML injection, credential exposure,
SSRF/network egress in web tools, path traversal in asset/scene routes, plugin
install/runtime boundaries, share/export data leaks, and cross-site requests
against the loopback API.

Out of scope: vulnerabilities requiring an already-compromised local machine,
model prompt injection without a security boundary bypass, and third-party model
provider behavior.

## Supported versions

Security fixes are issued for the latest release and the current `main` branch.
Before 1.0, there are no long-term support branches.

## Response expectations

- Acknowledge a report within 48 hours.
- Triage and reproduce within 7 days.
- Aim to ship a fix or mitigation within 90 days, faster for critical issues.
- Credit reporters in the advisory unless they prefer to stay anonymous.

## Safe harbor

We will not pursue legal action or report a researcher for good-faith testing
that stays within the scope above, avoids privacy violations and service
disruption, and reports findings privately before public disclosure.

See [docs/SECURITY.md](docs/SECURITY.md) for the trust model and known
limitations.
