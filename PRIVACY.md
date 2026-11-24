# Privacy

Three Studio is a local-first application. It does not operate a backend
service, does not require an account, and does not include telemetry, analytics
or crash reporting.

## Data stored locally

- `~/.three-studio/` (or `THREE_STUDIO_HOME`) contains provider settings,
  credentials, sessions, plugins, skills and scenes.
- `credentials.json` is written with mode `0600` and API keys are never returned
  by the HTTP API.
- Remove the data directory to delete all local Studio data.

## Network requests

Three Studio makes network requests only when you or the agent use a feature
that needs one:

- model calls to the provider you configured (prompt and tool context are sent
  to that provider under its terms);
- `web_fetch`, `web_search` and `deep_research` against public URLs;
- MCP servers, browser automation and the optional web pane that you
  explicitly configure or open;
- loading Three.js from jsDelivr in a **Standalone HTML** export (the exported
  page, not the Studio server).

The Studio server itself binds `127.0.0.1` and sends no telemetry. There is no
hosted sharing or cloud sync in the core.

## Exports and shares

Exports contain the scene and assets you choose to export. Share links are
capability URLs served by your local server; anyone who can reach the URL can
view the shared scene until it expires or is revoked. Do not share links that
contain confidential content.

## Changes

This document describes the core repository. A future hosted or team service
must publish its own privacy policy and data-processing terms.
