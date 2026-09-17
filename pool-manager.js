import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ACPClient } from "./acp-client.js";
import { SessionManager } from "./session-manager.js";

const HOME = os.homedir();
const DEFAULT_GEMINI_HOME = path.join(HOME, ".gemini");
const PROFILES_DIR = path.join(HOME, ".gemini-profiles");
const STATE_BASE_DIR = path.join(HOME, ".local/state/paseo-agy-acp");
const DEFAULT_COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || "600000", 10); // 10 minutes default cooldown on 429

export class ACPPool {
  constructor(options = {}) {
    this.command = options.command || "agy-acp";
    this.defaultCwd = options.cwd || process.cwd();
    this.workers = new Map(); // profileId -> WorkerEntry
    this.sessionAffinity = new Map(); // sessionKey -> profileId
    this.roundRobinIndex = 0;

    // Background auto-refresh of worker health & cooldown recovery every 10 seconds
    this.healthTimer = setInterval(() => {
      this.checkHealth();
    }, 10000);

    if (this.healthTimer.unref) {
      this.healthTimer.unref();
    }
  }

  async init() {
    console.log("[ACPPool] Initializing Antigravity ACP Worker Pool...");
    await this.refreshProfiles();
    console.log(`[ACPPool] Initialized ${this.workers.size} profile worker(s).`);
  }

  async refreshProfiles() {
    const discovered = new Set();

    // 1. Check Default profile (~/.gemini)
    const defaultToken = path.join(DEFAULT_GEMINI_HOME, "antigravity-acp", "acp_token.json");
    if (fs.existsSync(defaultToken)) {
      discovered.add("default");
      if (!this.workers.has("default")) {
        await this._addWorker("default", DEFAULT_GEMINI_HOME);
      }
    }

    // 2. Check Extra profiles (~/.gemini-profiles/*)
    if (fs.existsSync(PROFILES_DIR)) {
      const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const profileId = entry.name;
          const pHome = path.join(PROFILES_DIR, profileId);
          const tokenFile = path.join(pHome, "antigravity-acp", "acp_token.json");
          if (fs.existsSync(tokenFile)) {
            discovered.add(profileId);
            if (!this.workers.has(profileId)) {
              await this._addWorker(profileId, pHome);
            }
          }
        }
      }
    }

    // 3. Remove workers whose profiles were deleted
    for (const [profileId, worker] of this.workers.entries()) {
      if (!discovered.has(profileId)) {
        console.log(`[ACPPool] Profile '${profileId}' removed from disk. Shutting down worker...`);
        worker.acpClient.close();
        this.workers.delete(profileId);
        // Clear affinity
        for (const [sKey, pId] of this.sessionAffinity.entries()) {
          if (pId === profileId) this.sessionAffinity.delete(sKey);
        }
      }
    }
  }

  async _addWorker(profileId, geminiHome) {
    console.log(`[ACPPool] Registering worker profile: '${profileId}' (GEMINI_HOME=${geminiHome})`);
    const stateDir = path.join(STATE_BASE_DIR, profileId);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const env = {
      ...process.env,
      GEMINI_HOME: geminiHome,
      AGY_ACP_STATE_DIR: stateDir,
    };

    const acpClient = new ACPClient({
      command: this.command,
      cwd: this.defaultCwd,
      env,
    });

    const sessionManager = new SessionManager(acpClient);

    const worker = {
      id: profileId,
      geminiHome,
      tokenFile: path.join(geminiHome, "antigravity-acp", "acp_token.json"),
      stateDir,
      acpClient,
      sessionManager,
      status: "healthy", // "healthy" | "cooldown" | "error"
      cooldownUntil: 0,
      lastError: null,
      accountEmail: null,
      stats: {
        totalTurns: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalErrors: 0,
        total429s: 0,
      },
    };

    // Cache email asynchronously without blocking startup
    this._resolveWorkerEmail(worker).catch(() => {});

    this.workers.set(profileId, worker);
  }

  async _resolveWorkerEmail(worker) {
    try {
      const emailCacheFile = path.join(path.dirname(worker.tokenFile), ".cached_email");
      if (fs.existsSync(emailCacheFile)) {
        worker.accountEmail = fs.readFileSync(emailCacheFile, "utf8").trim();
        return;
      }
      const raw = fs.readFileSync(worker.tokenFile, "utf8");
      const data = JSON.parse(raw);
      if (!data.refresh_token) return;

      const body = new URLSearchParams({
        client_id: data.client_id,
        client_secret: data.client_secret || "",
        refresh_token: data.refresh_token,
        grant_type: "refresh_token",
      });

      const res = await fetch(data.token_uri || "https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const tr = await res.json();
        if (tr.access_token) {
          const uRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tr.access_token}` },
            signal: AbortSignal.timeout(5000),
          });
          if (uRes.ok) {
            const uInfo = await uRes.json();
            if (uInfo.email) {
              worker.accountEmail = uInfo.email;
              fs.writeFileSync(emailCacheFile, uInfo.email, "utf8");
            }
          }
        }
      }
    } catch {}
  }

  checkHealth() {
    const now = Date.now();
    for (const worker of this.workers.values()) {
      if (worker.status === "cooldown" && now >= worker.cooldownUntil) {
        console.log(`[ACPPool] Worker '${worker.id}' cooldown expired. Restoring to 'healthy'.`);
        worker.status = "healthy";
        worker.cooldownUntil = 0;
        worker.lastError = null;
      }
    }
  }

  markCooldown(profileId, reason, cooldownMs = DEFAULT_COOLDOWN_MS) {
    const worker = this.workers.get(profileId);
    if (!worker) return;

    worker.status = "cooldown";
    worker.cooldownUntil = Date.now() + cooldownMs;
    worker.lastError = reason;
    worker.stats.total429s += 1;

    console.warn(
      `[ACPPool] Worker '${profileId}' marked COOLDOWN for ${Math.round(
        cooldownMs / 1000
      )}s. Reason: ${reason}`
    );

    // Evict session affinity for this worker so subsequent turns smoothly migrate
    for (const [sKey, pId] of this.sessionAffinity.entries()) {
      if (pId === profileId) {
        this.sessionAffinity.delete(sKey);
      }
    }
  }

  isQuotaError(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("quota") ||
      msg.includes("exhausted") ||
      msg.includes("resource_exhausted") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests") ||
      msg.includes("capacity")
    );
  }

  getHealthyWorkers() {
    this.checkHealth();
    return Array.from(this.workers.values()).filter((w) => w.status === "healthy");
  }

  selectWorker(sessionKey) {
    this.checkHealth();

    // 1. Session Affinity Check
    const affinityProfileId = this.sessionAffinity.get(sessionKey);
    if (affinityProfileId) {
      const affineWorker = this.workers.get(affinityProfileId);
      if (affineWorker && affineWorker.status === "healthy") {
        return affineWorker;
      }
      // Stale affinity: worker in cooldown or removed
      this.sessionAffinity.delete(sessionKey);
    }

    // 2. Select from Healthy Workers
    const healthy = this.getHealthyWorkers();
    if (healthy.length === 0) {
      // If all are in cooldown, pick the one with earliest cooldown expiry
      const sortedByCooldown = Array.from(this.workers.values()).sort(
        (a, b) => a.cooldownUntil - b.cooldownUntil
      );
      if (sortedByCooldown.length > 0) {
        console.warn("[ACPPool] All workers are in cooldown! Selecting worker closest to recovery.");
        return sortedByCooldown[0];
      }
      throw new Error("No worker profiles configured in Antigravity ACP pool.");
    }

    // 3. Least-loaded selection with Round-Robin tiebreaker
    let bestWorker = healthy[0];
    let minActiveTurns = Infinity;

    for (const w of healthy) {
      const activeTurns = w.sessionManager.listSessions().reduce((acc, s) => acc + (s.activeTurns || 0), 0);
      if (activeTurns < minActiveTurns) {
        minActiveTurns = activeTurns;
        bestWorker = w;
      }
    }

    this.sessionAffinity.set(sessionKey, bestWorker.id);
    return bestWorker;
  }

  async executeTurn({
    sessionKey,
    messages,
    responseFormat = null,
    stream = false,
    model = null,
    cwd = this.defaultCwd,
    signal = null,
  }) {
    const attempted = new Set();
    const totalAvailable = this.workers.size;
    let lastErr = null;

    while (attempted.size < totalAvailable) {
      let worker;
      try {
        worker = this.selectWorker(sessionKey);
      } catch (selErr) {
        throw selErr;
      }

      if (attempted.has(worker.id)) {
        // If selectWorker returned an already attempted worker, find an untried healthy worker
        const remaining = this.getHealthyWorkers().filter((w) => !attempted.has(w.id));
        if (remaining.length === 0) break;
        worker = remaining[0];
        this.sessionAffinity.set(sessionKey, worker.id);
      }

      attempted.add(worker.id);
      worker.stats.totalTurns += 1;

      try {
        console.log(`[ACPPool] Routing session '${sessionKey}' -> Worker '${worker.id}' (Turn #${worker.stats.totalTurns})`);
        const result = await worker.sessionManager.executeTurn({
          sessionKey,
          messages,
          responseFormat,
          stream,
          model,
          cwd,
          signal,
        });

        if (stream) {
          result.once("done", ({ usage }) => {
            if (usage) {
              worker.stats.promptTokens += (usage.prompt_tokens || 0);
              worker.stats.completionTokens += (usage.completion_tokens || 0);
              worker.stats.totalTokens += (usage.total_tokens || 0);
            }
          });
        } else if (result?.usage) {
          worker.stats.promptTokens += (result.usage.prompt_tokens || 0);
          worker.stats.completionTokens += (result.usage.completion_tokens || 0);
          worker.stats.totalTokens += (result.usage.total_tokens || 0);
        }

        return result;
      } catch (turnErr) {
        lastErr = turnErr;
        worker.stats.totalErrors += 1;

        if (this.isQuotaError(turnErr)) {
          console.warn(`[ACPPool] Worker '${worker.id}' encountered quota exhaustion: ${turnErr.message}`);
          this.markCooldown(worker.id, turnErr.message);

          const healthyRemaining = this.getHealthyWorkers().filter((w) => !attempted.has(w.id));
          if (healthyRemaining.length > 0) {
            console.log(`[ACPPool] Initiating automatic failover to next healthy worker (${healthyRemaining.length} available)...`);
            continue;
          }
        }

        // Not a quota error or no failover targets left
        throw turnErr;
      }
    }

    throw new Error(
      `All ${attempted.size} Google account(s) in ACP pool are quota-exhausted or in cooldown. Last error: ${
        lastErr?.message || "Quota exceeded"
      }`
    );
  }

  async destroySession(sessionKey) {
    const profileId = this.sessionAffinity.get(sessionKey);
    if (profileId && this.workers.has(profileId)) {
      const worker = this.workers.get(profileId);
      this.sessionAffinity.delete(sessionKey);
      return await worker.sessionManager.destroySession(sessionKey);
    }
    // Try destroying across all workers if affinity not found
    let destroyed = false;
    for (const worker of this.workers.values()) {
      const res = await worker.sessionManager.destroySession(sessionKey);
      if (res) destroyed = true;
    }
    return destroyed;
  }

  async resetAllSessions() {
    this.sessionAffinity.clear();
    let totalCount = 0;
    for (const worker of this.workers.values()) {
      totalCount += await worker.sessionManager.resetAllSessions();
    }
    return totalCount;
  }

  listSessions() {
    const all = [];
    for (const [profileId, worker] of this.workers.entries()) {
      const sessions = worker.sessionManager.listSessions();
      for (const s of sessions) {
        all.push({
          ...s,
          workerProfileId: profileId,
          workerAccount: worker.accountEmail,
        });
      }
    }
    return all;
  }

  getSessionContext(sessionKey) {
    const profileId = this.sessionAffinity.get(sessionKey);
    if (profileId && this.workers.has(profileId)) {
      return this.workers.get(profileId).sessionManager.getSessionContext(sessionKey);
    }
    for (const worker of this.workers.values()) {
      const ctx = worker.sessionManager.getSessionContext(sessionKey);
      if (ctx) return ctx;
    }
    return null;
  }

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

  formatPrompt(messages, responseFormat = null) {
    // Shared formatter from first worker or static instance
    const sample = this.workers.values().next().value;
    if (sample) {
      return sample.sessionManager.acp.formatPrompt(messages, responseFormat);
    }
    return "";
  }

  getStatus() {
    this.checkHealth();
    const profiles = [];
    let totalTurnsActive = 0;

    for (const [id, worker] of this.workers.entries()) {
      const activeTurns = worker.sessionManager.listSessions().reduce((acc, s) => acc + (s.activeTurns || 0), 0);
      totalTurnsActive += activeTurns;

      profiles.push({
        id,
        status: worker.status,
        geminiHome: worker.geminiHome,
        accountEmail: worker.accountEmail,
        activeTurns,
        cooldownUntil: worker.cooldownUntil,
        lastError: worker.lastError,
        stats: { ...worker.stats },
      });
    }

    return {
      totalProfiles: this.workers.size,
      healthyProfiles: this.getHealthyWorkers().length,
      activeTurnsTotal: totalTurnsActive,
      sessionAffinityCount: this.sessionAffinity.size,
      profiles,
    };
  }
}
