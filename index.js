import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import { ACPClient, CANONICAL_MODELS, estimateTokens } from "./acp-client.js";
import { SessionManager } from "./session-manager.js";
import { authenticateRequest } from "./auth.js";

const PORT = parseInt(process.env.PORT || "1234", 10);
const ACP_COMMAND = process.env.ACP_COMMAND || "agy-acp";
const ACP_MODEL = process.env.ACP_MODEL || "gemini-3.8-flash-high";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.cwd();
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const HOST = process.env.HOST || null;

const CANONICAL_MODEL_SET = new Set(CANONICAL_MODELS);

const acp = new ACPClient({
  command: ACP_COMMAND,
  cwd: WORKSPACE_DIR,
});

const sessionManager = new SessionManager(acp);

function getTailscaleIp() {
  if (process.env.TAILSCALE_IP) {
    return process.env.TAILSCALE_IP;
  }
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name.includes("tailscale") || name.startsWith("ts")) {
      for (const addr of addrs || []) {
        if (addr.family === "IPv4" && !addr.internal) {
          return addr.address;
        }
      }
    }
  }
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal && addr.address.startsWith("100.")) {
        return addr.address;
      }
    }
  }
  return null;
}

function sendError(res, statusCode, message, type = "invalid_request_error", code = null) {
  console.error(`[HTTP ${statusCode}] ${type}: ${message}`);
  if (!res.headersSent) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
  }
  res.end(
    JSON.stringify({
      error: {
        message,
        type,
        param: null,
        code: code || statusCode,
      },
    })
  );
}

function formatOpenAICompletion(content, requestedModel, stopReason = "stop", usage = null) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || ACP_MODEL,
    system_fingerprint: "fp_antigravity_acp",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || "",
        },
        finish_reason: stopReason === "end_turn" ? "stop" : stopReason,
      },
    ],
    usage: usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function formatOpenAIStreamChunk(chunkId, deltaText, requestedModel, finishReason = null) {
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || ACP_MODEL,
    choices: [
      {
        index: 0,
        delta: deltaText ? { content: deltaText } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

function generateEmbedding(text, dimensions = 1536) {
  const vec = new Float64Array(dimensions);
  const words = (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    vec[0] = 1.0;
    return Array.from(vec);
  }

  for (const word of words) {
    let h1 = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
      h1 ^= word.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    const idx1 = Math.abs(h1) % dimensions;
    const sign1 = (h1 & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * 1.0;

    if (word.length >= 3) {
      for (let i = 0; i <= word.length - 3; i++) {
        const trigram = word.slice(i, i + 3);
        let h2 = 0x811c9dc5;
        for (let j = 0; j < trigram.length; j++) {
          h2 ^= trigram.charCodeAt(j);
          h2 = Math.imul(h2, 0x01000193);
        }
        const idx2 = Math.abs(h2) % dimensions;
        const sign2 = (h2 & 1) === 0 ? 0.5 : -0.5;
        vec[idx2] += sign2;
      }
    }
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vec[i] /= norm;
    }
  } else {
    vec[0] = 1.0;
  }

  return Array.from(vec);
}

const requestHandler = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Enforce Authentication
  if (!authenticateRequest(req, res, PROXY_API_KEY)) {
    return;
  }

  // Health Check
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    const tailscaleIp = getTailscaleIp();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        backend: ACP_COMMAND,
        default_model: ACP_MODEL,
        workspace: WORKSPACE_DIR,
        auth_enabled: Boolean(PROXY_API_KEY),
        tailscale_ip: tailscaleIp,
        active_sessions: sessionManager.listSessions(),
      })
    );
    return;
  }

  // Model List
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: CANONICAL_MODELS.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: id.startsWith("claude") ? "anthropic" : (id.startsWith("gpt") ? "openai" : "google-antigravity"),
        })),
      })
    );
    return;
  }

  // Session Management Endpoints
  if (req.method === "GET" && req.url === "/v1/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: sessionManager.listSessions() }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/sessions/reset") {
    let bodyRaw = "";
    req.on("data", (chunk) => (bodyRaw += chunk));
    req.on("end", async () => {
      let body = {};
      try {
        if (bodyRaw) body = JSON.parse(bodyRaw);
      } catch (e) {
        return sendError(res, 400, "Invalid JSON in request body", "invalid_request_error");
      }

      if (body.session_id) {
        await sessionManager.destroySession(body.session_id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, reset: body.session_id }));
      } else {
        const count = await sessionManager.resetAllSessions();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count }));
      }
    });
    return;
  }

  if (req.method === "DELETE" && req.url.startsWith("/v1/sessions/")) {
    const sessionId = decodeURIComponent(req.url.replace("/v1/sessions/", ""));
    const deleted = await sessionManager.destroySession(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionId, deleted }));
    return;
  }

  // Context & Token Inspection Endpoints
  if (req.method === "GET" && (req.url.startsWith("/v1/context") || req.url.includes("/context"))) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    let sessionKey = parsedUrl.searchParams.get("session_id") || req.headers["x-session-id"];
    if (!sessionKey && parsedUrl.pathname.startsWith("/v1/sessions/") && parsedUrl.pathname.endsWith("/context")) {
      sessionKey = decodeURIComponent(parsedUrl.pathname.replace("/v1/sessions/", "").replace("/context", ""));
    }
    sessionKey = sessionKey || "default";

    const ctx = sessionManager.getSessionContext(sessionKey);
    if (!ctx) {
      return sendError(res, 404, `No active context recorded for session '${sessionKey}'`, "not_found");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx));
    return;
  }

  // Chat Completions
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let bodyRaw = "";
    req.on("data", (chunk) => (bodyRaw += chunk));

    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        return sendError(res, 400, "Invalid JSON in request body", "invalid_request_error");
      }

      if (!body.messages || !Array.isArray(body.messages)) {
        return sendError(
          res,
          400,
          "Missing or invalid 'messages' array in request body",
          "invalid_request_error"
        );
      }

      const isStream = Boolean(body.stream);
      const requestedModel = body.model || ACP_MODEL;
      const canonicalModel = requestedModel;

      if (!CANONICAL_MODEL_SET.has(canonicalModel)) {
        return sendError(
          res,
          400,
          `Unsupported model '${requestedModel}'. Supported models: ${CANONICAL_MODELS.join(", ")}.`,
          "invalid_request_error"
        );
      }

      // Resolve logical session for concurrency and turn routing
      const sessionKey = sessionManager.resolveSessionKey(req, body);

      // Context size estimation upfront
      const promptText = acp.formatPrompt(body.messages, body.response_format);
      const promptChars = promptText.length;
      const promptTokens = estimateTokens(promptText);

      if (isStream) {
        // Immediate SSE headers to prevent tunnel timeouts
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Context-Prompt-Tokens": String(promptTokens),
          "X-Context-Chars": String(promptChars),
        });

        const chunkId = `chatcmpl-${crypto.randomUUID()}`;

        // Send initial SSE heartbeat comment immediately
        res.write(": keepalive\n\n");

        const initialChunk = formatOpenAIStreamChunk(chunkId, "", canonicalModel, null);
        initialChunk.choices[0].delta = { role: "assistant" };
        res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

        // Keep-Alive Heartbeat every 10s until completion to prevent tunnel idle timeouts
        let isEnded = false;
        const keepAliveTimer = setInterval(() => {
          if (!isEnded && !res.writableEnded) {
            try {
              res.write(": keepalive\n\n");
            } catch (err) {
              clearInterval(keepAliveTimer);
            }
          }
        }, 10000);

        const cleanup = () => {
          if (!isEnded) {
            isEnded = true;
            clearInterval(keepAliveTimer);
          }
        };

        req.on("close", cleanup);

        try {
          const emitter = await sessionManager.executeTurn({
            sessionKey,
            messages: body.messages,
            responseFormat: body.response_format,
            stream: true,
            model: canonicalModel,
            cwd: WORKSPACE_DIR,
          });

          emitter.on("chunk", (textChunk) => {
            if (textChunk && !res.writableEnded) {
              const openAIChunk = formatOpenAIStreamChunk(chunkId, textChunk, canonicalModel, null);
              res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
            }
          });

          emitter.on("done", ({ stopReason, usage, context }) => {
            cleanup();
            if (!res.writableEnded) {
              const finalReason = stopReason === "end_turn" ? "stop" : stopReason;
              const endChunk = formatOpenAIStreamChunk(chunkId, "", canonicalModel, finalReason);
              res.write(`data: ${JSON.stringify(endChunk)}\n\n`);

              const finalUsage = usage || {
                prompt_tokens: promptTokens,
                completion_tokens: 0,
                total_tokens: promptTokens,
              };
              const usageChunk = {
                id: chunkId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: canonicalModel,
                choices: [],
                usage: finalUsage,
              };
              res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);

              console.log(
                `[Turn Complete] Session '${sessionKey}' | Context: ${finalUsage.prompt_tokens} prompt tokens (${promptChars} chars), ${finalUsage.completion_tokens} completion tokens (${finalUsage.total_tokens} total)`
              );

              res.write("data: [DONE]\n\n");
              res.end();
            }
          });

          emitter.on("error", (err) => {
            cleanup();
            console.error("[Stream Error]", err);
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error" } })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            }
          });
        } catch (err) {
          cleanup();
          return sendError(res, 500, `ACP stream dispatch failed: ${err.message}`, "api_error");
        }
        return;
      }

      // Non-streaming turn execution
      try {
        const result = await sessionManager.executeTurn({
          sessionKey,
          messages: body.messages,
          responseFormat: body.response_format,
          stream: false,
          model: canonicalModel,
          cwd: WORKSPACE_DIR,
        });

        const openAIResponse = formatOpenAICompletion(
          result.content,
          canonicalModel,
          result.stopReason,
          result.usage
        );
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Context-Prompt-Tokens": String(result.context?.promptTokens || promptTokens),
          "X-Context-Chars": String(result.context?.promptChars || promptChars),
          "X-Completion-Tokens": String(result.context?.completionTokens || 0),
          "X-Total-Tokens": String(result.context?.totalTokens || promptTokens),
        });
        console.log(
          `[Turn Complete] Session '${sessionKey}' | Context: ${result.context?.promptTokens || promptTokens} prompt tokens (${result.context?.promptChars || promptChars} chars), ${result.context?.completionTokens || 0} completion tokens`
        );
        res.end(JSON.stringify(openAIResponse));
      } catch (err) {
        return sendError(res, 500, `ACP prompt execution failed: ${err.message}`, "api_error");
      }
    });
    return;
  }

  // Embeddings endpoint
  if (req.method === "POST" && req.url === "/v1/embeddings") {
    let bodyRaw = "";
    req.on("data", (chunk) => (bodyRaw += chunk));

    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        return sendError(res, 400, "Invalid JSON in request body", "invalid_request_error");
      }

      const input = body.input;
      if (!input) {
        return sendError(res, 400, "Missing 'input' field in request body", "invalid_request_error");
      }

      const texts = Array.isArray(input) ? input : [input];
      const dimensions = parseInt(body.dimensions || "1536", 10);
      const data = texts.map((text, index) => ({
        object: "embedding",
        index,
        embedding: generateEmbedding(typeof text === "string" ? text : JSON.stringify(text), dimensions),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data,
          model: body.model || "text-embedding-3-small",
          usage: {
            prompt_tokens: 0,
            total_tokens: 0,
          },
        })
      );
    });
    return;
  }

  sendError(res, 404, `Endpoint ${req.method} ${req.url} not found`, "invalid_request_error");
};

function printBanner(urls) {
  console.log(`=======================================================`);
  console.log(`🚀 Antigravity ACP ↔ OpenAI Proxy (Multi-Session + SSE Heartbeat)`);
  console.log(`- Default Model: ${ACP_MODEL}`);
  console.log(`- ACP Command: ${ACP_COMMAND}`);
  console.log(`- Workspace Dir: ${WORKSPACE_DIR}`);
  console.log(`- Auth Enabled: ${PROXY_API_KEY ? "YES (Bearer/x-api-key)" : "NO (Public)"}`);
  console.log(`- Active Listeners:`);
  for (const url of urls) {
    console.log(`  * ${url}`);
  }
  console.log(`- Health Check: ${urls[0]}/health`);
  console.log(`- Chat Endpoint: ${urls[0]}/v1/chat/completions`);
  console.log(`=======================================================`);
}

const tailscaleIp = getTailscaleIp();

if (HOST) {
  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => {
    printBanner([`http://${HOST}:${PORT}`]);
  });
} else {
  // Bind 127.0.0.1 and Tailscale interface (avoid unauthenticated 0.0.0.0 binding)
  const serverLocal = http.createServer(requestHandler);
  serverLocal.listen(PORT, "127.0.0.1", () => {
    const urls = [`http://127.0.0.1:${PORT}`];
    if (tailscaleIp && tailscaleIp !== "127.0.0.1") {
      const serverTailscale = http.createServer(requestHandler);
      serverTailscale.listen(PORT, tailscaleIp, () => {
        urls.push(`http://${tailscaleIp}:${PORT}`);
        printBanner(urls);
      });
      serverTailscale.on("error", (err) => {
        console.error(`[Tailscale Listener Error] Could not bind to ${tailscaleIp}:${PORT}:`, err.message);
        printBanner(urls);
      });
    } else {
      printBanner(urls);
    }
  });
}
