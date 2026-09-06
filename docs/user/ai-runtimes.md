# AI Runtimes

AI Runtimes are model endpoints, separate from agent providers such as OpenCode,
Codex, and Claude Code. Existing providers keep working without runtime configuration.

Open **Settings → AI Runtimes** on web, desktop, or mobile. Each connected environment
advertises its own catalog through its existing T3 connection. Discovery checks Ollama's
local API and caches the result; it does not scan your LAN or Tailnet. Use **Refresh**
to recheck availability and models. Offline nodes retain their last catalog, marked unavailable.

## Ollama

An existing Ollama endpoint or executable is reused. T3 only removes installations it
manages, and only stops processes it started. For a new installation, choose **Install
Ollama**, then **Start**. Official release archives are verified before activation.
Linux release extraction requires `tar` with zstd support. Installation and model pulls
continue if the client disconnects; reconnect to see progress or cancel the operation.

Updates install a new version for the next start. Stop and start the managed runtime to
use it. Removing a managed installation preserves downloaded models so reinstalling does
not require downloading them again. Remove individual models through **Manage models**.
Model pulls use the name you enter and show the progress reported by Ollama.

## Use a runtime on another node

By default, a managed Ollama listens on `127.0.0.1:11434`.

For direct Tailnet access, configure its **Network base URL** using the owning node's
Tailscale IPv4 address and port 11434, then explicitly enable **Allow managed Tailnet
listening**. Stop and start the runtime. T3 verifies that the address belongs to this
node before binding it. Tailnet ACLs control access; Ollama itself does not authenticate
API calls. T3 does not enable public exposure, LAN wildcard listening, or Tailscale Funnel.
Disable the option and restart to return to loopback-only listening.

For an externally managed runtime, configure its private listener yourself and enter the
network address in T3. Select **Use on another node**, choose the consuming environment,
and configure that environment's credentials if needed. The consuming server tests the
endpoint itself. An advertised address alone is not proof that another node can reach it.
This direct connection requires a network route between the servers; a T3 Connect relay
connection by itself does not supply that route.

## Manual and cloud endpoints

Use **Add runtime** under the environment that will connect to the endpoint. Enter its
name, runtime type, compatibility, base URL, and authentication. For OpenAI compatibility,
include the API prefix in the URL, such as `https://host/v1`. Anthropic endpoints use the
API root. Model catalogs are read from the endpoint. Capabilities are shown only when
reported by a supported discovery API; otherwise they remain unknown.

Custom and transcription compatibility can store endpoint and model metadata, but have
no universal health or model discovery protocol. They remain unverified and cannot be
bound to a coding agent in this version. STT, TTS, and Agent Profiles can build on the
runtime contracts without becoming coding-agent providers.

API keys are saved in the selected environment's secret store and are not returned in
catalogs. Leaving the key untouched preserves it; changing it updates dependent agent
bindings. Credentials are configured separately on each consuming environment.

## Bind an agent

Expand **Use with an agent**, choose the harness and an available model, and enter a new
provider instance ID. T3 creates a provider instance with the required configuration:

- **OpenCode:** OpenAI Chat Completions compatibility, with per-instance configuration.
- **Codex:** OpenAI Responses compatibility. Chat Completions alone is insufficient.
- **Claude Code:** Anthropic Messages compatibility, including Ollama's compatible API.

Choose the resulting provider and model in the existing chat selectors. Model compatibility
and tool quality depend on the runtime/model; catalog discovery does not perform an inference
benchmark. Cursor, Grok, and Antigravity retain their existing provider configuration.

Endpoint or credential edits update its bindings. Remove a binding in **Settings → Providers**
before forgetting its endpoint or switching to a protocol that the bound harness cannot use.
