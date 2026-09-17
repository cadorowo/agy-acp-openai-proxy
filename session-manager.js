/**
 * SessionManager coordinates multi-client session routing and queues for Antigravity ACP.
 * Concurrency constraint: ACP only permits 1 active turn per ACP session.
 * By mapping each client/conversation to its own session with an independent turn queue,
 * multiple remote clients can execute turns concurrently without blocking each other.
 */

export class SessionManager {
  constructor(acpClient, options = {}) {
    this.acp = acpClient;
    this.ttlMs = options.ttlMs || 30 * 60 * 1000; // 30 minutes idle TTL
    this.sweepIntervalMs = options.sweepIntervalMs || 5 * 60 * 1000; // 5 minutes sweep
    this.turnTimeoutMs = options.turnTimeoutMs || parseInt(process.env.TURN_TIMEOUT_MS || "300000", 10); // 5 minutes turn timeout
    this.sessions = new Map(); // sessionKey -> { sessionKey, acpSessionId, currentModelId, cwd, lastActiveAt, activeTurns, closing }
    this.creating = new Map(); // sessionKey -> Promise<session>
    this.queues = new Map(); // sessionKey -> Promise for the last queued turn

    this.sweepTimer = setInterval(() => {
      this.sweepExpiredSessions().catch((err) => {
        console.error("[SessionManager] Error during sweep:", err);
      });
    }, this.sweepIntervalMs);

    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }

    // Invalidate session mapping if the underlying ACP child process exits
    this.acp.on("exit", () => {
      console.warn("[SessionManager] ACP backend process exited. Invalidating all session mappings.");
      this.sessions.clear();
      this.creating.clear();
      this.queues.clear();
    });
  }

  /**
   * Resolves the session key from HTTP request headers, body, or fallback.
   * Priority:
   * 1. X-Session-Id header
   * 2. OpenAI body.user field
   * 3. Fallback: 'default'
   */
  resolveSessionKey(req, body = {}) {
    const headerKey = req.headers["x-session-id"];
    if (headerKey && typeof headerKey === "string" && headerKey.trim()) {
      return headerKey.trim();
    }
    const user = body?.user;
    if (user && typeof user === "string" && user.trim()) {
      return user.trim();
    }
    return "default";
  }

  async getOrCreateSession(sessionKey, { cwd, model } = {}) {
    let session = this.sessions.get(sessionKey);

    // If session is expired, evict and recreate
    if (session && Date.now() - session.lastActiveAt > this.ttlMs) {
      console.log(`[SessionManager] Session '${sessionKey}' expired (idle > ${this.ttlMs / 60000}m). Evicting...`);
      await this.destroySession(sessionKey);
      session = null;
    }

    if (!session) {
      let creation = this.creating.get(sessionKey);
      if (!creation) {
        console.log(`[SessionManager] Spawning new ACP session for key='${sessionKey}' (cwd=${cwd || "default"})...`);
        creation = this.acp.createNewSession(cwd).then(({ sessionId, currentModelId }) => {
          const created = {
            sessionKey,
            acpSessionId: sessionId,
            currentModelId,
            cwd,
            lastActiveAt: Date.now(),
            activeTurns: 0,
            closing: false,
            turnCount: 0,
            lastPromptTokens: 0,
            lastCompletionTokens: 0,
            lastTotalTokens: 0,
            lastPromptChars: 0,
            lastCompletionChars: 0,
          };
          this.sessions.set(sessionKey, created);
          return created;
        }).finally(() => this.creating.delete(sessionKey));
        this.creating.set(sessionKey, creation);
      }
      session = await creation;
    } else {
      session.lastActiveAt = Date.now();
    }

    // If a different model is requested, update it on the ACP session
    if (model) {
      const targetModel = this.acp.normalizeModelId(model);
      if (targetModel && targetModel !== session.currentModelId) {
        try {
          await this.acp.setSessionModel(session.acpSessionId, targetModel);
          session.currentModelId = targetModel;
        } catch (err) {
          this.sessions.delete(sessionKey);
          try {
            await this.acp.cancelSession(session.acpSessionId);
          } catch (cancelErr) {
            console.warn(`[SessionManager] Could not cancel session '${sessionKey}' after model switch failure:`, cancelErr.message);
          }
          throw new Error(`Unable to switch model for session '${sessionKey}': ${err.message}`);
        }
      }
    }

    return session;
  }

  /**
   * Executes a turn serialized on this session's dedicated queue.
   * Distinct sessions run concurrently.
   * Supports turnTimeoutMs and optional AbortSignal to cancel orphaned turns.
   */
  executeTurn({ sessionKey, messages, responseFormat = null, stream = false, model = null, cwd, signal = null }) {
    return new Promise((resolveResult, rejectResult) => {
      if (signal?.aborted) {
        return rejectResult(new Error("Turn aborted by client before execution"));
      }

      // Ensure session object stub exists to chain the queue
      const queueSoFar = this.queues.get(sessionKey) || Promise.resolve();

      const turnWork = queueSoFar
        .catch(() => {}) // Prevent previous turn failure from breaking subsequent turns
        .then(async () => {
          if (signal?.aborted) {
            const err = new Error("Turn aborted by client while queued");
            rejectResult(err);
            return;
          }

          let activeSession;
          try {
            activeSession = await this.getOrCreateSession(sessionKey, { cwd, model });
          } catch (initErr) {
            rejectResult(initErr);
            return;
          }

          activeSession.lastActiveAt = Date.now();
          activeSession.activeTurns = (activeSession.activeTurns || 0) + 1;
          const promptText = this.acp.formatPrompt(messages, responseFormat);

          let turnTimer = null;
          let turnAborted = false;
          let streamEmitter = null;

          const timeoutPromise = new Promise((_, reject) => {
            turnTimer = setTimeout(() => {
              reject(new Error(`Turn execution timed out after ${this.turnTimeoutMs}ms on session '${sessionKey}'`));
            }, this.turnTimeoutMs);
            if (turnTimer.unref) turnTimer.unref();
          });

          let abortPromise = null;
          let onAbort = null;
          if (signal) {
            abortPromise = new Promise((_, reject) => {
              onAbort = () => {
                turnAborted = true;
                reject(new Error("Turn aborted by client"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
            });
          }

          const cancelRaceList = abortPromise ? [timeoutPromise, abortPromise] : [timeoutPromise];

          try {
            if (stream) {
              const sessionPromise = this.acp.executeOnSession({
                sessionId: activeSession.acpSessionId,
                promptText,
                stream: true,
              });

              const { emitter, completionPromise } = await Promise.race([
                sessionPromise,
                ...cancelRaceList,
              ]);

              streamEmitter = emitter;

              emitter.once("done", ({ context }) => {
                activeSession.turnCount = (activeSession.turnCount || 0) + 1;
                if (context) {
                  activeSession.lastPromptTokens = context.promptTokens;
                  activeSession.lastCompletionTokens = context.completionTokens;
                  activeSession.lastTotalTokens = context.totalTokens;
                  activeSession.lastPromptChars = context.promptChars;
                  activeSession.lastCompletionChars = context.completionChars;
                }
              });

              // Hand emitter back to HTTP handler immediately for real-time SSE streaming
              resolveResult(emitter);

              // Await prompt completion, timeout, or client abort
              await Promise.race([completionPromise, ...cancelRaceList]);
              activeSession.lastActiveAt = Date.now();
            } else {
              const result = await Promise.race([
                this.acp.executeOnSession({
                  sessionId: activeSession.acpSessionId,
                  promptText,
                  stream: false,
                  responseFormat,
                }),
                ...cancelRaceList,
              ]);

              activeSession.turnCount = (activeSession.turnCount || 0) + 1;
              if (result.context) {
                activeSession.lastPromptTokens = result.context.promptTokens;
                activeSession.lastCompletionTokens = result.context.completionTokens;
                activeSession.lastTotalTokens = result.context.totalTokens;
                activeSession.lastPromptChars = result.context.promptChars;
                activeSession.lastCompletionChars = result.context.completionChars;
              }
              activeSession.lastActiveAt = Date.now();
              resolveResult(result);
            }
          } catch (turnErr) {
            console.warn(`[SessionManager] Turn error on session '${sessionKey}': ${turnErr.message}`);
            // Evict broken or aborted session so subsequent turns start with a clean state
            this.sessions.delete(sessionKey);
            try {
              await this.acp.cancelSession(activeSession.acpSessionId);
            } catch (e) {}

            if (streamEmitter) {
              streamEmitter.emit("error", turnErr);
            }
            rejectResult(turnErr);
          } finally {
            if (turnTimer) clearTimeout(turnTimer);
            if (signal && onAbort) signal.removeEventListener("abort", onAbort);
            activeSession.activeTurns = Math.max(0, (activeSession.activeTurns || 1) - 1);
          }
        });

      this.queues.set(sessionKey, turnWork);
      turnWork.finally(() => {
        if (this.queues.get(sessionKey) === turnWork) this.queues.delete(sessionKey);
      }).catch(() => {});
    });
  }

  async destroySession(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    session.closing = true;
    this.sessions.delete(sessionKey);
    try {
      await this.acp.cancelSession(session.acpSessionId);
    } catch (e) {}
    console.log(`[SessionManager] Session '${sessionKey}' destroyed`);
    return true;
  }

  async resetAllSessions() {
    const keys = Array.from(this.sessions.keys());
    for (const key of keys) {
      await this.destroySession(key);
    }
    return keys.length;
  }

  async sweepExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (!session.activeTurns && !this.queues.has(key) && now - session.lastActiveAt > this.ttlMs) {
        console.log(`[SessionManager Sweep] Auto-evicting expired session '${key}' (idle for ${Math.floor((now - session.lastActiveAt) / 1000)}s)`);
        await this.destroySession(key);
      }
    }
  }

  getSessionContext(sessionKey) {
    const s = this.sessions.get(sessionKey);
    if (!s) return null;
    return {
      sessionKey,
      acpSessionId: s.acpSessionId,
      currentModel: s.currentModelId,
      turnCount: s.turnCount || 0,
      context: {
        promptTokens: s.lastPromptTokens || 0,
        completionTokens: s.lastCompletionTokens || 0,
        totalTokens: s.lastTotalTokens || 0,
        promptChars: s.lastPromptChars || 0,
        completionChars: s.lastCompletionChars || 0,
      },
    };
  }

  listSessions() {
    const now = Date.now();
    return Array.from(this.sessions.entries()).map(([key, s]) => ({
      key,
      acpSessionId: s.acpSessionId,
      currentModel: s.currentModelId,
      idleSeconds: Math.floor((now - s.lastActiveAt) / 1000),
      lastActiveAt: new Date(s.lastActiveAt).toISOString(),
      activeTurns: s.activeTurns || 0,
      queued: this.queues.has(key),
      turnCount: s.turnCount || 0,
      context: {
        promptTokens: s.lastPromptTokens || 0,
        completionTokens: s.lastCompletionTokens || 0,
        totalTokens: s.lastTotalTokens || 0,
        promptChars: s.lastPromptChars || 0,
        completionChars: s.lastCompletionChars || 0,
      },
    }));
  }
}
