# LLM & Agent Integration Guide: `agy-acp-openai-proxy`

**Target Audience:** Autonomous Agents, Remote LLM Orchestrators (Paseo, Hermes, LangChain, LlamaIndex, Cursor, Open WebUI, AutoGen), and Systems Engineers.  
**Specification Level:** Strict Technical Specification for Machine Consumption.

---

## 1. Overview & Connection Endpoints

The proxy exposes a standard **OpenAI v1-compatible REST API** that transparently bridges to the host machine's Antigravity ACP (`agy_acp_server`) kernel.

### Network Endpoints
* **Localhost (Host Machine):** `http://127.0.0.1:1234/v1`
* **Remote / Tailscale Mesh:** `http://<YOUR_SERVER_IP>:1234/v1`
* **Health Check:** `http://127.0.0.1:1234/health` or `http://<YOUR_SERVER_IP>:1234/health`

---

## 2. Authentication

* **Header:** `Authorization: Bearer <PROXY_API_KEY>` or `X-Api-Key: <PROXY_API_KEY>`
* If `PROXY_API_KEY` is not set on the proxy server, the API operates in open mode, but setting a token is required when exposed outside trusted networks.
* Standard `OPTIONS` CORS preflight and `GET /health` requests bypass authentication.

---

## 3. Session Routing & Concurrency Model

### 3.1 The Golden Rule: Use `X-Session-Id`
The underlying ACP kernel strictly prohibits concurrent prompt execution on the same session (failing with `A foreground turn is already active`).  
The proxy solves this by providing **per-session queuing and multi-session isolation**.

* **Always pass a unique session identifier:**
  1. Header: `X-Session-Id: <tenant-or-chat-uuid>` *(Recommended)*
  2. Or OpenAI Body Field: `"user": "<tenant-or-chat-uuid>"`
* **Behavior:**
  * Requests with **distinct** session IDs run **concurrently in parallel**.
  * Concurrent requests with the **same** session ID are automatically **serialized** in FIFO order on that session's queue, preventing turn collisions.
  * If omitted, requests fallback to the shared `'default'` session.

### 3.2 Context History Strategy (Stateless Client vs. Stateful Kernel)
* **Standard OpenAI clients** send the entire conversation history in `messages: [...]` on every turn.
* The ACP kernel maintains an internal stateful buffer for each active session.
* **LLM Best Practice:**
  * If using a persistent `X-Session-Id` for an ongoing agent turn, be aware that sending the full message array on each HTTP request formats all messages into the turn prompt.
  * For isolated task execution where you manage full context locally, either:
    - Generate a fresh `X-Session-Id` per logical task/thread.
    - Or issue `DELETE /v1/sessions/<session_id>` to clear the session when starting a new context.

---

## 4. Supported Models & Aliases

The proxy supports dynamic model switching per turn without dropping the session. Both canonical IDs and popular aliases are recognized:

| Model Description | Canonical ID | Recognized Aliases |
| :--- | :--- | :--- |
| **Claude 3.7 / 4.6 Sonnet** | `claude-sonnet-4-6` | `claude-4.6-sonnet`, `claude-sonnet`, `claude-3-7-sonnet` |
| **Claude 4.6 Opus Thinking** | `claude-opus-4-6-thinking` | `claude-4.6-opus`, `claude-opus-4-6`, `claude-opus`, `opus` |
| **Gemini 3.8 Flash High** | `gemini-3.8-flash-high` | `gemini-3.8-flash`, `gemini-3.7-flash` |
| **Gemini 3.8 Flash Medium** | `gemini-3.8-flash-medium` | - |
| **Gemini 3.8 Flash Low** | `gemini-3.8-flash-low` | - |
| **Open Source 120B** | `gpt-oss-120b-medium` | `gpt-oss-120b` |

*Query available models programmatically:* `GET /v1/models`

---

## 5. Streaming (SSE) & Keep-Alive Guidelines

For reasoning models (`claude-opus-4-6-thinking`), time-to-first-token (TTFT) can reach 15–45 seconds.

* **Always prefer `stream: true`** for long agentic tasks.
* **Keep-Alive Comments:** The proxy immediately emits `: keepalive\n\n` upon connection and every 10 seconds thereafter until completion.
* **Client Parser Requirement:** RFC 8895 / SSE standard states lines beginning with `:` are comments and MUST be ignored by the client parser. Ensure your SSE parser does not attempt to parse `: keepalive` as JSON data chunks.
* **Premature Termination:** If the client disconnects (`req.close`), the proxy cleans up timers and marks the turn completed.

---

## 6. Structured Output (`response_format`)

The proxy features a built-in JSON sanitization engine for `response_format`:

```json
{
  "model": "claude-4.6-sonnet",
  "messages": [{"role": "user", "content": "Extract items"}],
  "response_format": {
    "type": "json_object"
  }
}
```
* Or strict schema: `{"type": "json_schema", "json_schema": { "name": "Output", "schema": { ... } }}`
* The proxy strips accidental markdown code blocks (````json ... ````) and normalizes output into a valid JSON string.

---

## 7. Administrative & Session Management Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/v1/sessions` | Lists all active sessions, models, and idle times. |
| `DELETE` | `/v1/sessions/:id` | Evicts and cleans up a specific session. |
| `POST` | `/v1/sessions/reset` | Resets all sessions (or pass `{"session_id": "..."}`). |
| `GET` | `/health` | Returns server health, active model, and Tailscale IP. |

---

## 8. Integration Examples

### A. Python (Official `openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1234/v1",  # Or http://<YOUR_SERVER_IP>:1234/v1
    api_key="your-proxy-key",            # Dummy string if no key is configured
    default_headers={"X-Session-Id": "agent-thread-001"}
)

response = client.chat.completions.create(
    model="claude-4.6-sonnet",
    messages=[
        {"role": "system", "content": "You are a senior systems assistant."},
        {"role": "user", "content": "Analyze the process table."}
    ],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
```

### B. TypeScript / Node.js (`fetch`)

```typescript
const response = await fetch("http://localhost:1234/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer your-proxy-key",
    "X-Session-Id": "agent-task-42"
  },
  body: JSON.stringify({
    model: "claude-opus-4-6-thinking",
    messages: [{ role: "user", content: "Write a high-performance socket server." }],
    stream: false
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

### C. cURL (CLI Quick Test)

```bash
# Streaming turn with custom session ID
curl -N -X POST http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: terminal-test" \
  -d '{
    "model": "claude-4.6-sonnet",
    "messages": [{"role": "user", "content": "Hello from remote terminal"}],
    "stream": true
  }'
```

---

## 9. Failure Modes & Recovery Matrix

| Status / Error | Probable Cause | Action |
| :--- | :--- | :--- |
| `401 Unauthorized` | Invalid or missing `Authorization` header. | Verify `PROXY_API_KEY` matches proxy environment. |
| `400 Unsupported model` | Model name not recognized. | Check `GET /v1/models` and use exact alias. |
| `500 A foreground turn is already active` | Race condition on the same session without queue. | Ensure unique `X-Session-Id` per concurrent agent or let the proxy queue serialize requests. |
| Connection Timeout | Upstream thinking without keepalive. | Ensure client does not drop connection on `: keepalive` SSE comments. |
| Host Memory Cap Reached | Too many idle ACP sessions (>1500MB). | Call `POST /v1/sessions/reset` to purge stale sessions. |
