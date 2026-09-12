# ⚡ agy-acp-openai-proxy

OpenAI-compatible HTTP gateway for **Antigravity ACP** (Agent Client Protocol).

Translates standard OpenAI `/v1/chat/completions` requests into ACP JSON-RPC streams over `stdio`, supporting multi-session routing, Server-Sent Events (SSE) streaming, and bearer authentication.

---

## 🎯 Features

- **OpenAI Compatible**: Exposes standard `/v1/chat/completions` and `/v1/models` endpoints.
- **Full Streaming (SSE)**: Streams tokens in real time compatible with OpenAI SDKs and frontends.
- **Multi-Session Isolation**: Automatically routes and manages persistent ACP sessions via `X-Session-Id` or `user` field.
- **Model Support**:
  - `gemini-3.8-flash-high`
  - `gemini-3.8-flash-medium`
  - `gemini-3.8-flash-low`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
- **Optional Bearer Auth**: Secure access via `PROXY_API_KEY` (`Authorization: Bearer <key>` or `X-Api-Key`).
- **Zero External Dependencies**: Pure Node.js standard library (Node.js >= 18).

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

By default, listens on port `1234` (`http://0.0.0.0:1234`).

### Health Check

```bash
curl http://localhost:1234/health
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
| `SESSION_TTL_MS` | `1800000` (30 min) | Session timeout before recycling processes |

---

## 📚 Documentation

More guides and technical specifications are available in the [`docs/`](./docs) folder:
- [LLM Integration Guide](./docs/LLM_INTEGRATION_GUIDE.md)
- [Sessions and Tunnels RFC](./docs/SESSIONS_AND_TUNNELS_RFC.md)
- [Proxy Evaluator Prompt](./docs/PROXY_EVALUATOR_PROMPT.md)
