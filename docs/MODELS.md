# Models and providers

Three Studio talks directly to model providers from the standalone server. No
Harness model service is required.

## Built-in providers

On first run `models.json` seeds two providers:

| Provider id | API | Default base URL | Models |
| --- | --- | --- | --- |
| `deepseek` | OpenAI-compatible chat completions | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` |
| `anthropic` | Anthropic Messages | `https://api.anthropic.com/v1` | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |

Add an API key in **AI Prompt → gear → Model providers**, or add a custom
provider.

## Selecting a model

The composer keeps the session model switch inside the input box at the
bottom-right. It lists every provider/model from the catalog and an optional
reasoning-effort select when the model declares efforts. Selection is stored on
the session (`selection` in `sessions.json`) and used by the next prompt.

Provider/model IDs are the wire identifiers sent to the provider. Display names
are UI labels only.

## Adding a provider

**Add** opens a form with:

- **Provider id** — lowercase letters, digits and hyphens, starting with a letter
  (for example `acme-gateway`)
- **Display name** — UI label
- **Base URL** — `http(s)` endpoint root
- **Protocol** — `openai-completions` or `anthropic-messages`
- **Model ids** — comma- or newline-separated
- **API key** — optional at creation; can be set later

The provider is written to `models.json`; the key is stored separately in
`credentials.json` under `<PROVIDER_ID>_API_KEY`.

## Editing and deleting providers

Each editable provider card exposes **Edit** and **Delete**:

- **Edit** reopens the provider form with its display name, base URL, protocol
  and model ids. Saving updates the provider and its model list in place; the
  stored API key is preserved.
- Removing model ids from the model list removes them from the picker.
- **Delete** asks for a second confirmation, then removes the provider from
  `models.json` and its key from `credentials.json`. Sessions whose selected
  provider/model disappears are reset to no explicit selection.
- Built-in seeded providers can also be removed; use **Add** to recreate them
  with a different endpoint or model list.

## Storage

`~/.three-studio/models.json` (no secrets):

```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "api": "openai-completions",
      "baseURL": "https://api.deepseek.com/v1",
      "models": [
        { "id": "deepseek-chat", "name": "DeepSeek Chat" }
      ]
    }
  ]
}
```

`~/.three-studio/credentials.json` (mode `0600`):

```json
{ "deepseek": "<your API key>" }
```

Secrets are write-only from the UI: the server reports `keyConfigured` but never
returns the key value.

## Wire behavior

### OpenAI-compatible

`POST <baseURL>/chat/completions` with `stream: true`, Bearer auth, and tool
definitions in `tools[].function`. Streaming deltas are folded into text and
tool-call arguments.

### Anthropic Messages

`POST <baseURL>/messages` with `anthropic-version: 2023-06-01`, `x-api-key`,
`stream: true`, and tools as `{name, description, input_schema}`. Text deltas
and `tool_use` input JSON deltas are accumulated.

## Reasoning effort

Models may declare `reasoning` with `efforts` and a default. The composer and
Settings view show an effort select; the selected value is stored in the session
selection. Provider adapters currently pass the model ID and tool configuration;
extended-thinking parameters can be added in `agent.mjs` when the provider
requires them.

## Errors

- Missing key: the prompt fails with `Add an API key for <provider> in Settings.`
- HTTP failures: the provider status and a bounded response body are shown as the
  agent error.
- Tool errors: reported per tool call; the agent may continue and correct itself.
- Streaming failures leave the session idle and surface the error in the AI panel.

## Custom model discovery

The standalone build does not call provider model-discovery endpoints. Add model
ids explicitly in the add-provider form or in `models.json`. This keeps the
provider surface predictable and avoids extra network calls.
