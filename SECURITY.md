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
install/runtime boundaries, and share/export data leaks.

Out of scope: vulnerabilities requiring an already-compromised local machine,
model prompt injection without a security boundary bypass, and third-party model
provider behavior.

See [docs/SECURITY.md](docs/SECURITY.md) for the trust model and known
limitations.
