# Technical RFC: Multi-Client Session Management & Remote Tunneling for Antigravity ACP OpenAI Proxy

**Status:** Accepted & Implemented (v1.1)  
**Target Audience:** LLM Architects, Systems Engineers, and Autonomous Agent Developers.  
**System Under Review:** `agy-acp-openai-proxy` bridging local Antigravity ACP (Google Cloud Code / Claude 4.6 / Gemini) to OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`).

---

## 1. Executive Summary & Context

The host machine (Linux ThinkPad X1 Carbon) runs an official Antigravity ACP kernel (`agy_acp_server`) patched with `kernel-compat` to unlock non-Gemini models (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`).
A local Node.js proxy (`agy-acp-openai-proxy`, port 1234) translates standard OpenAI REST requests into ACP JSON-RPC over `stdio`.

The objective is to allow **remote external clients (other PCs, LLMs, IDEs, and orchestration agents)** to consume this proxy across network boundaries (via Tailscale, Cloudflare Tunnel, or Wireguard).

Before scaling to multi-device usage, critical architectural risks around **concurrency, session isolation, execution security, and network transport** were identified and addressed.

---

## 2. Core Architectural Concerns: Sessions

### 2.1 The Single-Turn Constraint (`A foreground turn is already active`)
* **ACP Root Behavior:** Google's ACP engine (`agy_acp_server`) strictly prohibits concurrent `session/prompt` requests on a single session. 
* **The Failure Mode:** If client A sends a prompt while client B is still generating tokens or running a tool, the engine throws `Error: A foreground turn is already active`. In Paseo, this causes unrecoverable `turn_failed` states.
* **Implemented Mitigation:** 
  * `SessionManager` maintains an isolated queue (`Promise.resolve()` chain) per logical session ID.
  * Requests across different sessions proceed in parallel.
  * Requests sharing the same session ID are serialized, preventing engine collisions.

### 2.2 History Duplication vs. Conversational Continuity
* **The OpenAI API Paradigm:** Stateless from the server's perspective; the client sends the *entire* message array (`messages: [...]`) on every turn.
* **The ACP Paradigm:** Stateful; the server-side kernel maintains the agent's internal message buffer across turns.
* **Behavior & Trade-off:**
  * For long-running conversational threads with a fixed `X-Session-Id`, passing the entire accumulated history on every turn results in repeated context injections into the ACP buffer.
  * **Recommendation for Agents:** When executing independent tasks, supply a fresh `X-Session-Id` per task or call `DELETE /v1/sessions/:id` between unrelated conversations.

### 2.3 Session Routing & Multi-Tenancy Strategy
* **Identification:** Requests are routed to distinct ACP sessions using:
  1. `X-Session-Id` HTTP header.
  2. `body.user` (standard OpenAI field).
  3. Fallback to `'default'`.
* **Isolation:** Each logical session ID owns its own ACP `sessionId` and independent `turnQueue`.
* **TTL & Eviction Policy:**
  * Idle sessions expire automatically after 30 minutes.
  * Sweep interval runs every 5 minutes.
  * Management endpoints:
    - `GET /v1/sessions`: Inspect active sessions, model IDs, and idle times.
    - `POST /v1/sessions/reset`: Bulk reset or specific session reset.
    - `DELETE /v1/sessions/:id`: Explicit session teardown.
* **Known Backend Constraint (`session/cancel`):**
  * The ACP kernel (`agy_acp_server`) returns `Method not found` on `session/cancel`. Eviction releases the Node.js mapping and queue references; backend process state is recycled when the proxy or kernel restarts.

---

## 3. Core Architectural Concerns: Remote Access & Tunnels

### 3.1 Tunnel Transport Comparison

| Solution | Latency Overhead | SSE / Streaming Compatibility | Security / Auth Layer | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Tailscale (Mesh VPN)** | Near-zero (direct Wireguard P2P) | Native raw TCP, zero buffering | Tailscale node auth, private IPs | **Active & Recommended** (`100.74.82.76:1234`) |
| **Cloudflare Tunnel (cloudflared)** | Moderate (routed via Cloudflare edge) | Requires chunked transfer & disabled response buffering | Needs Cloudflare Access / Service Tokens | Optional for public ingress |
| **SSH Reverse Tunnel (`ssh -R`)** | Minimal | Native raw TCP | SSH key authentication | Reliable fallback |

### 3.2 Security & Network Binding
* **Current State:** The proxy operates with `modeId: "yolo"` and auto-approves tool requests (`session/request_permission` $\rightarrow$ `"allow"`).
* **Implemented Mitigations:**
  1. **Network Binding:** Bound exclusively to `127.0.0.1` and the verified Tailscale interface IP (`100.74.82.76:1234`). Public LAN binding (`0.0.0.0`) is disabled.
  2. **Bearer Token Authentication:** Enforced via `auth.js` when `PROXY_API_KEY` is provided in environment.
  3. **CORS Preflight:** Standard permissive CORS with preflight `OPTIONS` handling.

### 3.3 Streaming (SSE) Buffering & Long-Thinking Timeouts
* Reasoning models (`claude-opus-4-6-thinking`) take 15–45 seconds before outputting the first token chunk.
* **Implemented Mitigation:**
  * Immediate HTTP 200 headers with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, and `X-Accel-Buffering: no`.
  * Immediate initial SSE comment `: keepalive\n\n`.
  * Cyclic keepalive ping every 10 seconds until prompt completion to prevent tunnel/reverse proxy 504 drops.

---

## 4. Operational Architecture & Reference Files

1. **[session-manager.js](file:///home/ggg/vibes/agy-acp-openai-proxy/session-manager.js)**:
   - Manages session lifetime, TTL eviction, and turn queues.
2. **[auth.js](file:///home/ggg/vibes/agy-acp-openai-proxy/auth.js)**:
   - Authenticates requests against `PROXY_API_KEY`.
3. **[acp-client.js](file:///home/ggg/vibes/agy-acp-openai-proxy/acp-client.js)**:
   - ACP JSON-RPC over stdio, auto-reconnect, model alias resolution, structured JSON parser.
4. **[index.js](file:///home/ggg/vibes/agy-acp-openai-proxy/index.js)**:
   - HTTP server, SSE streaming, Tailscale IP detection, OpenAI formatters.
5. **[LLM_INTEGRATION_GUIDE.md](file:///home/ggg/vibes/agy-acp-openai-proxy/docs/LLM_INTEGRATION_GUIDE.md)**:
   - Dedicated operational reference for external LLMs, agent frameworks, and SDK clients.
