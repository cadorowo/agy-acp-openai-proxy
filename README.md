# ⚡ agy-acp-openai-proxy

OpenAI-compatible HTTP gateway for **Antigravity ACP** (Agent Client Protocol) with **Multi-Account Pooling & Automatic 429 Failover**.

Translates standard OpenAI `/v1/chat/completions` requests into ACP JSON-RPC streams over `stdio`, supporting multi-account quota multiplication, multi-session routing, Server-Sent Events (SSE) streaming with keepalives, and bearer authentication.

---

## 🎯 Features

- **Multi-Account Quota Pooling**: Pool multiple independent Google accounts (`~/.gemini-profiles/*`) to multiply your rate limits and daily quota $N\times$.
- **Transparent 429 Failover**: Automatically detects `429`, `QUOTA_EXHAUSTED`, or capacity limits, marks the worker in temporary cooldown, and seamlessly re-routes the turn to another healthy account.
- **Smart Session Affinity**: Keeps turns of the same session on the same worker when possible to maximize token caching and reduce latency.
- **OpenAI Compatible**: Exposes standard `/v1/chat/completions` and `/v1/models` endpoints.
- **Full Streaming (SSE)**: Real-time SSE streaming with 10s keepalive heartbeats to prevent tunnel/proxy timeouts.
- **Turn Timeout & Client Abort**: Clean abort handling via `AbortController` and configurable turn timeouts.
- **CLI Profile Manager (`agy-profile`)**: Manage and authenticate accounts via terminal or remotely.
- **Zero External Dependencies**: Pure Node.js standard library (Node.js >= 18).

---

## 🚀 Multi-Account Management (`agy-profile`)

The proxy includes the `agy-profile` CLI tool for linking and managing Google accounts.

```bash
# List all connected accounts and their Google email addresses
agy-profile list

# Connect a new Google account
agy-profile login google2

# Check live pool status (workers, active turns, cooldowns)
agy-profile status

# Test connection and session creation for a profile
agy-profile test google2
```

### Remote Authentication (over SSH / Headless)
When running remotely:
1. Run `agy-profile login <profile_name>` in your SSH terminal.
2. Click the Google OAuth link in your local browser.
3. Sign in and authorize.
4. When redirected to `localhost`, copy the URL from your browser address bar and paste it into the terminal prompt.
5. The token is saved and the proxy immediately integrates the new account into the pool without restarts!

---

## 🚀 Quick Start

### Installation & Run

```bash
# Clone the repository
git clone https://github.com/cadorowo/agy-acp-openai-proxy.git
cd agy-acp-openai-proxy

# Copy example environment
cp .env.example .env

# Run server
npm start
```

By default, listens on port `1234` (`http://127.0.0.1:1234` and Tailscale IP if present).

### Health & Pool Status Check

```bash
# Basic health check
curl http://localhost:1234/health

# Pool status
curl http://localhost:1234/v1/pool/status
```

---

## 📡 API Usage

### 1. List Models

```bash
curl http://localhost:1234/v1/models
```

### 2. Chat Completions (Streaming)

```bash
curl -N -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -H "X-Session-Id: my-session-1" \
  -d '{
    "model": "gemini-3.8-flash-high",
    "messages": [
      {"role": "user", "content": "Explain quantum entanglement in simple terms."}
    ],
    "stream": true
  }'
```

### 3. Chat Completions (Non-Streaming)

```bash
curl -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PROXY_API_KEY>" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {"role": "user", "content": "Write a quick Python hello world script."}
    ],
    "stream": false
  }'
```

---

## ⚙️ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `1234` | HTTP server port |
| `ACP_COMMAND` | `agy-acp` | Path or command to spawn the ACP backend |
| `ACP_MODEL` | `gemini-3.8-flash-high` | Default model if none specified |
| `PROXY_API_KEY` | *(empty)* | Optional API token to enforce authentication |
| `COOLDOWN_MS` | `600000` (10 min) | Cooldown duration when a profile encounters quota limits |
| `TURN_TIMEOUT_MS` | `300000` (5 min) | Maximum turn execution timeout |
| `SESSION_TTL_MS` | `1800000` (30 min) | Idle session timeout |

---

## 📚 Documentation

More guides and technical specifications are available in the [`docs/`](./docs) folder:
- [LLM Integration Guide](./docs/LLM_INTEGRATION_GUIDE.md)
- [Sessions and Tunnels RFC](./docs/SESSIONS_AND_TUNNELS_RFC.md)
- [Proxy Evaluator Prompt](./docs/PROXY_EVALUATOR_PROMPT.md)
