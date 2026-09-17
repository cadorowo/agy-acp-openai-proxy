#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";

const HOME = os.homedir();
const DEFAULT_GEMINI_HOME = path.join(HOME, ".gemini");
const PROFILES_DIR = path.join(HOME, ".gemini-profiles");
const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:1234";

function ensureProfilesDir() {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  }
}

async function fetchEmailFromToken(tokenFile) {
  if (!fs.existsSync(tokenFile)) return null;
  try {
    const raw = fs.readFileSync(tokenFile, "utf8");
    const data = JSON.parse(raw);
    const refreshToken = data.refresh_token;
    const clientId = data.client_id;
    const clientSecret = data.client_secret || "";
    const tokenUri = data.token_uri || "https://oauth2.googleapis.com/token";

    if (!refreshToken) return null;

    const emailCacheFile = path.join(path.dirname(tokenFile), ".cached_email");
    if (fs.existsSync(emailCacheFile)) {
      const stats = fs.statSync(emailCacheFile);
      if (Date.now() - stats.mtimeMs < 24 * 3600 * 1000) {
        return fs.readFileSync(emailCacheFile, "utf8").trim();
      }
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return "⚠️ token_refresh_failed";
    }

    const tokenRes = await res.json();
    const accessToken = tokenRes.access_token;
    if (!accessToken) return "⚠️ no_access_token";

    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });

    if (userRes.ok) {
      const userInfo = await userRes.json();
      if (userInfo.email) {
        try {
          fs.writeFileSync(emailCacheFile, userInfo.email, "utf8");
        } catch {}
        return userInfo.email;
      }
    }
    return "authorized (no email)";
  } catch (err) {
    return `⚠️ ${err.message}`;
  }
}

async function listProfiles() {
  ensureProfilesDir();
  console.log("\n=======================================================");
  console.log(" 🌐 Antigravity ACP — Profili Multi-Account Registrati");
  console.log("=======================================================\n");

  const profiles = [];

  // Default profile
  const defaultToken = path.join(DEFAULT_GEMINI_HOME, "antigravity-acp", "acp_token.json");
  profiles.push({
    name: "default (primario)",
    id: "default",
    geminiHome: DEFAULT_GEMINI_HOME,
    tokenFile: defaultToken,
    hasToken: fs.existsSync(defaultToken),
  });

  // Extra profiles
  if (fs.existsSync(PROFILES_DIR)) {
    const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pHome = path.join(PROFILES_DIR, entry.name);
        const token = path.join(pHome, "antigravity-acp", "acp_token.json");
        profiles.push({
          name: entry.name,
          id: entry.name,
          geminiHome: pHome,
          tokenFile: token,
          hasToken: fs.existsSync(token),
        });
      }
    }
  }

  for (const p of profiles) {
    let email = "Nessun token presente (esegui agy-profile login " + p.id + ")";
    let status = "❌ Non configurato";

    if (p.hasToken) {
      const resolved = await fetchEmailFromToken(p.tokenFile);
      if (resolved && !resolved.startsWith("⚠️")) {
        email = resolved;
        status = "✅ Attivo & Autenticato";
      } else {
        email = resolved || "Token non valido";
        status = "⚠️ Errore autenticazione";
      }
    }

    console.log(`▸ Profilo: \x1b[1m\x1b[36m${p.name}\x1b[0m`);
    console.log(`  Stato:    ${status}`);
    console.log(`  Account:  \x1b[33m${email}\x1b[0m`);
    console.log(`  Directory: ${p.geminiHome}\n`);
  }

  console.log("-------------------------------------------------------");
  console.log(`Totale profili rilevati: ${profiles.length}`);
  console.log("Aggiungi un account:  agy-profile login <nome>");
  console.log("Testa un account:     agy-profile test <nome>");
  console.log("-------------------------------------------------------\n");
}

async function loginProfile(name) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error("❌ Nome profilo non valido. Usa solo lettere, numeri, trattini e underscore.");
    process.exit(1);
  }

  const profileHome = name === "default" ? DEFAULT_GEMINI_HOME : path.join(PROFILES_DIR, name);
  const acpDir = path.join(profileHome, "antigravity-acp");
  fs.mkdirSync(acpDir, { recursive: true, mode: 0o700 });

  // Copy default settings if not exists
  const settingsFile = path.join(acpDir, "settings.json");
  const defaultSettings = path.join(DEFAULT_GEMINI_HOME, "antigravity-acp", "settings.json");
  if (!fs.existsSync(settingsFile) && fs.existsSync(defaultSettings)) {
    fs.copyFileSync(defaultSettings, settingsFile);
  }

  console.log(`\n🔑 Avvio procedura di login Google per il profilo: \x1b[1m\x1b[36m${name}\x1b[0m`);
  console.log(`📁 GEMINI_HOME: ${profileHome}\n`);

  const env = {
    ...process.env,
    GEMINI_HOME: profileHome,
    AGY_ACP_STATE_DIR: path.join(HOME, ".local/state/paseo-agy-acp", name),
  };

  const child = spawn("agy-acp", ["--login"], {
    env,
    stdio: "inherit",
  });

  child.on("exit", async (code) => {
    if (code === 0) {
      console.log(`\n✅ Login completato con successo per '${name}'!`);
      const token = path.join(acpDir, "acp_token.json");
      const email = await fetchEmailFromToken(token);
      console.log(`🎉 Account Google collegato: \x1b[32m${email}\x1b[0m\n`);

      // Notify proxy
      await notifyProxyRefresh();
    } else {
      console.error(`\n❌ Procedura di login terminata con errore (codice ${code}).`);
    }
  });
}

async function testProfile(name = "default") {
  const profileHome = name === "default" ? DEFAULT_GEMINI_HOME : path.join(PROFILES_DIR, name);
  const tokenFile = path.join(profileHome, "antigravity-acp", "acp_token.json");

  if (!fs.existsSync(tokenFile)) {
    console.error(`❌ Il profilo '${name}' non ha un file acp_token.json valido.`);
    console.error(`Esegui prima: agy-profile login ${name}`);
    process.exit(1);
  }

  const email = await fetchEmailFromToken(tokenFile);
  console.log(`\n🧪 Test del profilo \x1b[1m\x1b[36m${name}\x1b[0m (${email})...`);

  const env = {
    ...process.env,
    GEMINI_HOME: profileHome,
    AGY_ACP_STATE_DIR: path.join(HOME, ".local/state/paseo-agy-acp", name),
  };

  const child = spawn("agy-acp", [], { env, stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: child.stdout });

  let initialized = false;
  let sessionId = null;

  const timer = setTimeout(() => {
    console.error("\n❌ Test fallito: timeout comunicazione con ACP.");
    child.kill("SIGKILL");
    process.exit(1);
  }, 15000);

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) {
        initialized = true;
        process.stdout.write(" ▸ Inizializzazione kernel: OK\n");
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: HOME, mcpServers: [] },
          }) + "\n"
        );
      } else if (msg.id === 2 && msg.result?.sessionId) {
        sessionId = msg.result.sessionId;
        process.stdout.write(` ▸ Creazione sessione: OK (${sessionId})\n`);
        clearTimeout(timer);
        child.stdin.end();
        console.log(`\n🎉 \x1b[32mProfilo '${name}' perfettamente funzionante e pronto all'uso nel pool!\x1b[0m\n`);
        setTimeout(() => {
          child.kill("SIGTERM");
          process.exit(0);
        }, 300);
      } else if (msg.error) {
        clearTimeout(timer);
        console.error("\n❌ Errore kernel:", msg.error);
        child.kill("SIGTERM");
        process.exit(1);
      }
    } catch {}
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n"
  );
}

async function removeProfile(name) {
  if (!name || name === "default") {
    console.error("❌ Non puoi rimuovere il profilo 'default'.");
    process.exit(1);
  }

  const profileHome = path.join(PROFILES_DIR, name);
  if (!fs.existsSync(profileHome)) {
    console.error(`❌ Profilo '${name}' non trovato.`);
    process.exit(1);
  }

  fs.rmSync(profileHome, { recursive: true, force: true });
  console.log(`🗑️ Profilo '${name}' rimosso con successo.`);
  await notifyProxyRefresh();
}

async function notifyProxyRefresh() {
  try {
    const res = await fetch(`${PROXY_URL}/v1/pool/profiles/refresh`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      console.log("🔄 Segnalato aggiornamento al pool proxy (127.0.0.1:1234)!");
    }
  } catch {}
}

async function getPoolStatus() {
  try {
    const res = await fetch(`${PROXY_URL}/v1/pool/status`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log("\n=======================================================");
    console.log(" 📊 Stato Attuale del Pool Proxy (Port 1234)");
    console.log("=======================================================\n");
    console.log(`Totale Profili:   ${data.totalProfiles}`);
    console.log(`Profili Sani:     ${data.healthyProfiles}`);
    console.log(`Turni in corso:   ${data.activeTurnsTotal}\n`);
    for (const p of data.profiles) {
      const icon = p.status === "healthy" ? "🟢" : (p.status === "cooldown" ? "⏳" : "🔴");
      console.log(`${icon} \x1b[1m${p.id}\x1b[0m — Stato: ${p.status} | Account: ${p.accountEmail || "N/A"} | Turni attivi: ${p.activeTurns}`);
      if (p.cooldownUntil && p.cooldownUntil > Date.now()) {
        const secs = Math.ceil((p.cooldownUntil - Date.now()) / 1000);
        console.log(`   └─ Cooldown residuo: ${secs}s (Motivo: ${p.lastError || "429 Quota"})`);
      }
    }
    console.log("\n-------------------------------------------------------\n");
  } catch (err) {
    console.log(`⚠️ Impossibile contattare il proxy su ${PROXY_URL}: ${err.message}`);
    console.log("Verifica che il servizio `agy-acp-proxy` sia avviato.");
  }
}

async function main() {
  const [cmd, arg1] = process.argv.slice(2);

  switch (cmd) {
    case "list":
    case "ls":
      await listProfiles();
      break;
    case "login":
    case "add":
      if (!arg1) {
        console.error("Uso: agy-profile login <nome_profilo>");
        process.exit(1);
      }
      await loginProfile(arg1);
      break;
    case "test":
      await testProfile(arg1 || "default");
      break;
    case "remove":
    case "rm":
      if (!arg1) {
        console.error("Uso: agy-profile remove <nome_profilo>");
        process.exit(1);
      }
      await removeProfile(arg1);
      break;
    case "status":
      await getPoolStatus();
      break;
    default:
      console.log(`
Antigravity ACP Profile Manager — Multi-Account & Multi-Session CLI

Comandi disponibili:
  agy-profile list              Elenca tutti i profili registrati e i relativi account Google
  agy-profile login <nome>      Collega un nuovo account Google con nome specificato
  agy-profile test [nome]       Verifica la connettività e le credenziali di un profilo
  agy-profile status            Mostra lo stato in tempo reale del pool proxy (salute, turni, cooldown)
  agy-profile remove <nome>     Rimuove un profilo secondario
`);
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
