import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export const CANONICAL_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
];

export const POPULAR_ALIASES = [];

export const ALL_SUPPORTED_MODELS = [...CANONICAL_MODELS, ...POPULAR_ALIASES];

/**
 * Fast BPE token count approximation across code, English, and multilingual text.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const matches = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+|\s+/gu);
  if (!matches) return Math.ceil(text.length / 3.8);
  let count = 0;
  for (const m of matches) {
    count += m.length <= 4 ? 1 : Math.ceil(m.length / 3.5);
  }
  return Math.max(1, count);
}

/**
 * ACPClient drives the real Agent Client Protocol (ACP) over stdio with agy-acp.
 */
export class ACPClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.command = config.command || "agy-acp";
    this.defaultCwd = config.cwd || process.cwd();
    this.env = config.env || {};
    this.childProcess = null;
    this.requestId = 1;
    this.pending = new Map();
    this.activePrompts = new Map(); // sessionId -> { emitter, fullText }
    this.buffer = "";
    this.isReady = false;
    this.initPromise = null;
  }

  close() {
    if (this.childProcess) {
      try {
        this.childProcess.kill("SIGTERM");
      } catch {}
      this.childProcess = null;
      this.isReady = false;
      this.initPromise = null;
    }
  }

  async ensureStarted() {
    if (this.childProcess && this.isReady) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const [bin, ...args] = this.command.split(" ");
      console.error(`[ACPClient] Spawning ACP backend: ${bin} ${args.join(" ")}`);

      this.childProcess = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.env },
      });

      this.childProcess.stdout.setEncoding("utf-8");
      this.childProcess.stdout.on("data", (chunk) => this._onData(chunk));

      this.childProcess.stderr.setEncoding("utf-8");
      this.childProcess.stderr.on("data", (data) => {
        console.error(`[ACP stderr] ${data.trim()}`);
      });

      this.childProcess.on("exit", (code, signal) => {
        console.error(`[ACPClient] Child process exited (code=${code}, signal=${signal})`);
        this.childProcess = null;
        this.isReady = false;
        this.initPromise = null;
        for (const entry of this.pending.values()) {
          if (entry.timeout) clearTimeout(entry.timeout);
          entry.reject(new Error(`ACP backend exited (code=${code}, signal=${signal})`));
        }
        this.pending.clear();
        this.emit("exit", { code, signal });
      });

      this.childProcess.on("error", (err) => {
        console.error("[ACPClient] Child process spawn error:", err);
        this.isReady = false;
        this.initPromise = null;
        for (const entry of this.pending.values()) {
          if (entry.timeout) clearTimeout(entry.timeout);
          entry.reject(err);
        }
        this.pending.clear();
        this.emit("error", err);
      });

      // Handshake: initialize
      const initRes = await this._sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      console.error("[ACPClient] Initialized successfully:", initRes);
      this.isReady = true;
    })();

    return this.initPromise;
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (err) {
        console.error("[ACPClient] Failed to parse NDJSON line:", trimmed, err);
      }
    }
  }

  _handleMessage(msg) {
    // JSON-RPC Notification (e.g. session/update)
    if (msg.method === "session/update" && msg.params) {
      const { sessionId, update } = msg.params;
      const active = this.activePrompts.get(sessionId);
      if (active && update) {
        const textChunk = this._extractTextFromUpdate(update);
        if (textChunk) {
          active.fullText += textChunk;
          active.emitter.emit("chunk", textChunk);
        }
      }
      return;
    }

    // Inbound Request from ACP (e.g. session/request_permission)
    if (msg.method === "session/request_permission" && msg.id !== undefined) {
      const optionId = msg.params?.options?.[0]?.optionId || "allow";
      const reply = {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          outcome: {
            optionId,
          },
        },
      };
      if (this.childProcess && this.childProcess.stdin.writable) {
        this.childProcess.stdin.write(JSON.stringify(reply) + "\n");
      }
      return;
    }

    // JSON-RPC Response
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (entry.timeout) clearTimeout(entry.timeout);
      const { resolve, reject } = entry;

      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }

  _extractTextFromUpdate(update) {
    if (!update) return "";
    if (typeof update.text === "string") return update.text;
    if (typeof update.content === "string") return update.content;
    if (update.content && typeof update.content.text === "string") {
      return update.content.text;
    }
    if (update.delta && typeof update.delta.text === "string") {
      return update.delta.text;
    }
    if (Array.isArray(update.content)) {
      return update.content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }
    return "";
  }

  _sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.childProcess || !this.childProcess.stdin.writable) {
        return reject(new Error(`ACP backend is not running to process '${method}'`));
      }

      const id = this.requestId++;
      const timeout = setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(new Error(`ACP request '${method}' timed out after 120000ms`));
      }, 120000);
      this.pending.set(id, { resolve, reject, timeout });

      const payload = { jsonrpc: "2.0", id, method, params };
      this.childProcess.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  formatPrompt(messages, responseFormat = null) {
    let formatted = messages
      .map((m) => {
        const role = m.role?.toUpperCase() || "USER";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]\n${content}`;
      })
      .join("\n\n");

    if (responseFormat) {
      if (responseFormat.type === "json_schema" && responseFormat.json_schema?.schema) {
        const schema = responseFormat.json_schema.schema;
        formatted += `\n\n[CRITICAL SYSTEM DIRECTIVE: STRICT JSON OUTPUT REQUIRED]\nYou MUST respond ONLY with a single valid JSON object strictly matching the following JSON schema:\n${JSON.stringify(schema, null, 2)}\nDo NOT wrap the output in markdown fences (do NOT use \`\`\`json). Do NOT add explanations, bullet points, or markdown. Output ONLY the raw JSON string starting with { and ending with }.`;
      } else if (responseFormat.type === "json_object") {
        formatted += `\n\n[CRITICAL SYSTEM DIRECTIVE: STRICT JSON OUTPUT REQUIRED]\nYou MUST respond ONLY with a single valid JSON object. Do NOT wrap the output in markdown fences (do NOT use \`\`\`json). Do NOT add explanations, bullet points, or markdown. Output ONLY the raw JSON string starting with { and ending with }.`;
      }
    }

    return formatted;
  }

  processJsonOutput(rawText, responseFormat) {
    if (!responseFormat) return rawText || "";

    let text = (rawText || "").trim();

    // 1. Strip markdown code fences if present (```json ... ``` or ``` ...)
    const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      text = fenceMatch[1].trim();
    }

    // 2. Direct JSON check
    try {
      JSON.parse(text);
      return text;
    } catch (e) {}

    // 3. Search for outermost { ... }
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = text.slice(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch (e) {}
    }

    // 4. Fallback for PromptRepresentation schemas
    const isPromptRepresentation =
      responseFormat.json_schema?.name === "PromptRepresentation" ||
      (responseFormat.json_schema?.schema?.properties && "explicit" in responseFormat.json_schema.schema.properties) ||
      text.includes("stated") ||
      text.includes("reported") ||
      text.startsWith("-") ||
      text.startsWith("*");

    if (isPromptRepresentation) {
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-") || l.startsWith("*") || /^\d+\./.test(l));

      if (lines.length > 0) {
        const explicit = lines.map((line) => {
          const content = line.replace(/^([-*]|\d+\.)\s*/, "").trim();
          return { content };
        });
        return JSON.stringify({ explicit });
      }

      if (text.length > 0 && !text.startsWith("{")) {
        return JSON.stringify({ explicit: [{ content: text }] });
      }

      return JSON.stringify({ explicit: [] });
    }

    return text;
  }

  normalizeModelId(requested) {
    if (!requested) return null;
    const clean = requested.toLowerCase().trim();
    const aliasMap = {
      "claude-4.6-sonnet": "claude-sonnet-4-6",
      "claude-sonnet-4.6": "claude-sonnet-4-6",
      "claude-sonnet": "claude-sonnet-4-6",
      "claude-3-7-sonnet": "claude-sonnet-4-6",
      "claude-3.7-sonnet": "claude-sonnet-4-6",
      "sonnet": "claude-sonnet-4-6",
      "claude-4.6-opus": "claude-opus-4-6-thinking",
      "claude-opus-4.6": "claude-opus-4-6-thinking",
      "claude-opus": "claude-opus-4-6-thinking",
      "claude-opus-4-6": "claude-opus-4-6-thinking",
      "opus": "claude-opus-4-6-thinking",
      "gpt-oss-120b": "gpt-oss-120b-medium",
      "gemini-3.7-flash": "gemini-3.7-flash-high",
      "gemini-3.8-flash": "gemini-3.8-flash-high",
      "gemini-3.6-flash": "gemini-3.6-flash-high",
      "gemini-pro": "gemini-pro-agent",
    };
    return aliasMap[clean] || clean;
  }

  async createNewSession(cwd = this.defaultCwd) {
    await this.ensureStarted();
    console.error(`[ACPClient] Creating new ACP session in ${cwd}...`);
    const sessionRes = await this._sendRequest("session/new", { cwd, mcpServers: [] });
    const sessionId = sessionRes?.sessionId;
    if (!sessionId) {
      throw new Error("ACP did not return a sessionId in session/new result");
    }

    const currentModelId = sessionRes?.models?.currentModelId || null;

    // Set YOLO / automatic permission execution mode
    try {
      await this._sendRequest("session/set_mode", { sessionId, modeId: "yolo" });
    } catch (e) {
      try {
        await this._sendRequest("session/set_mode", { sessionId, modeId: "dangerously_skip_permissions" });
      } catch (e2) {}
    }

    console.error(`[ACPClient] Created ACP session ${sessionId} (model: ${currentModelId})`);
    return { sessionId, currentModelId };
  }

  async cancelSession(sessionId) {
    if (!sessionId || !this.childProcess) return;
    try {
      await this._sendRequest("session/cancel", { sessionId });
      console.error(`[ACPClient] Cancelled session ${sessionId}`);
    } catch (err) {
      // Non-fatal if session is already gone or cancelled
      console.error(`[ACPClient] session/cancel notice for ${sessionId}: ${err.message}`);
    }
  }

  async setSessionModel(sessionId, requestedModel) {
    const targetModel = this.normalizeModelId(requestedModel);
    if (!targetModel) return;

    try {
      await this._sendRequest("session/set_config_option", {
        sessionId,
        configId: "model",
        value: targetModel,
      });
      console.error(`[ACPClient] Switched model on ${sessionId} to: ${targetModel}`);
    } catch (err) {
      try {
        await this._sendRequest("session/set_model", {
          sessionId,
          modelId: targetModel,
        });
        console.error(`[ACPClient] Switched model on ${sessionId} to: ${targetModel}`);
      } catch (fallbackErr) {
        console.error(`[ACPClient] Could not switch model to ${targetModel} on ${sessionId}: ${fallbackErr.message}`);
        throw new Error(`Could not switch model to ${targetModel}: ${fallbackErr.message}`);
      }
    }
    return targetModel;
  }

  /**
   * Dispatches a prompt to an active session.
   * Returns:
   * - stream=false: Promise<{ content, stopReason }>
   * - stream=true: Promise<{ emitter, completionPromise }>
   */
  async executeOnSession({ sessionId, promptText, stream = false, responseFormat = null }) {
    const emitter = new EventEmitter();
    const record = { emitter, fullText: "" };
    this.activePrompts.set(sessionId, record);

    const promptChars = promptText ? promptText.length : 0;
    const estimatedPromptTokens = estimateTokens(promptText);

    const promptPromise = this._sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });

    if (stream) {
      const completionPromise = (async () => {
        try {
          const res = await promptPromise;
          this.activePrompts.delete(sessionId);
          const completionChars = record.fullText.length;
          const promptTokens = (res?.usage?.inputTokens ?? res?.usage?.prompt_tokens) || estimatedPromptTokens;
          const completionTokens = (res?.usage?.outputTokens ?? res?.usage?.completion_tokens) || estimateTokens(record.fullText);
          const usage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
          const context = {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            promptChars,
            completionChars,
          };
          emitter.emit("done", {
            fullText: record.fullText,
            stopReason: res?.stopReason || "end_turn",
            usage,
            context,
          });
          return res;
        } catch (err) {
          this.activePrompts.delete(sessionId);
          emitter.emit("error", err);
          throw err;
        }
      })();

      return { emitter, completionPromise };
    }

    // Non-streaming
    try {
      const res = await promptPromise;
      const finalContent = this.processJsonOutput(record.fullText, responseFormat);
      const completionChars = (finalContent || "").length;
      const promptTokens = (res?.usage?.inputTokens ?? res?.usage?.prompt_tokens) || estimatedPromptTokens;
      const completionTokens = (res?.usage?.outputTokens ?? res?.usage?.completion_tokens) || estimateTokens(finalContent);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      const context = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        promptChars,
        completionChars,
      };
      return {
        content: finalContent,
        stopReason: res?.stopReason || "stop",
        usage,
        context,
      };
    } finally {
      this.activePrompts.delete(sessionId);
    }
  }
}
