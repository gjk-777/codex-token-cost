#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 17888;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DB_PATH = path.join(os.homedir(), ".codex", "codex-live-token-cost-helper.json");
const DEFAULT_CC_SWITCH_DB_PATH = path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const CACHE_TTL_MS = 60000;
const CC_SWITCH_CACHE_TTL_MS = 60000;
const CC_SWITCH_ERROR_CACHE_TTL_MS = 5000;
const PYTHON_TIMEOUT_MS = 30000;
const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_CODEX_SESSIONS_PATH = path.join(os.homedir(), ".codex", "sessions");
const CODEX_SESSION_CACHE_TTL_MS = 60000;
const CODEX_SESSION_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CODEX_SESSION_CACHE_VERSION = 2;
const SUPPORTED_CODEX_ORIGINATORS = new Set(["Codex Desktop", "codex_vscode"]);

function normalizeText(value, max = 120) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readFileText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeJson(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch {
    // The bridge remains live when its optional metadata cache cannot be written.
  }
}

function readJson(file, fallback = {}) {
  const value = safeJsonParse(readFileText(file), fallback);
  return value && typeof value === "object" ? value : fallback;
}

function sessionTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sessionUsageDelta(previous, current) {
  const keys = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "total_tokens"];
  const delta = {};
  for (const key of keys) {
    const value = Math.max(0, Number(current?.[key] || 0));
    const old = Math.max(0, Number(previous?.[key] || 0));
    delta[key] = value >= old ? value - old : value;
  }
  return delta;
}

function sessionInvocation(value) {
  const server = String(value?.server || value?.server_name || value?.serverName || value?.plugin_name || value?.pluginName || "").trim().replace(/^\$+/, "");
  if (!server) return null;
  const id = String(value?.call_id || value?.callId || value?.id || "").trim();
  return { type: "plugin", plugin_id: server, plugin_name: server, ...(id ? { invocationId: id } : {}) };
}

function sessionSkillInvocations(value) {
  if (!value || typeof value !== "object") return [];
  const eventType = String(value.type || value.name || "").toLowerCase();
  const fields = [value.input, value.command, value.arguments, value.params, value.skill, value.skill_name, value.skillName, value.skill_id, value.skillId];
  const input = fields.filter((item) => item !== undefined && item !== null)
    .map((item) => typeof item === "string" ? item : JSON.stringify(item))
    .join("\n");
  const names = new Set();
  const pattern = /[\\/]skills[\\/]+(?:[^\\/"'\r\n]+[\\/]+)*([^\\/"'\r\n]+)[\\/]SKILL\.md/gi;
  for (const match of input.matchAll(pattern)) {
    if (match[1]) names.add(match[1].trim());
  }
  const explicitSkill = value.skill_name || value.skillName || value.skill_id || value.skillId ||
    (eventType.includes("skill") && value.name !== "exec" ? value.name : "");
  if (typeof explicitSkill === "string" && explicitSkill.trim() && !/[\\/]/.test(explicitSkill)) names.add(explicitSkill.trim());
  if (!names.size && value.name === "exec" && /\bskills?[:\s]/i.test(input)) {
    const match = input.match(/\bskills?[:\s]+([A-Za-z0-9_.-]+)/i);
    if (match?.[1]) names.add(match[1]);
  }
  const callId = String(value.call_id || value.callId || value.id || "").trim();
  return Array.from(names, (name) => ({
    type: "skill",
    skill_id: name,
    skill_name: name,
    ...(callId ? { invocationId: `${callId}:skill:${name}` } : {}),
  }));
}

async function listJsonlFiles(root) {
  const files = [];
  if (!root || !fs.existsSync(root)) return files;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(fullPath);
    }
  }
  return files.sort();
}

async function parseCodexSessionFile(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let sessionId = "";
  let originator = "";
  let source = "";
  let currentTurnId = "";
  let previousUsage = null;
  const turns = new Map();
  const ensureTurn = (turnId, timestamp = Date.now()) => {
    const id = String(turnId || "").trim();
    if (!id) return null;
    if (!turns.has(id)) turns.set(id, {
      turnId: id,
      sessionKey: sessionId || path.resolve(filePath),
      threadKey: sessionId,
      threadAttributionStatus: "reliable",
      source: "codex-session",
      importSource: "codex-session",
      platform: originator || source || "codex",
      model: "未知",
      effort: "",
      fastMode: null,
      usage: { input: 0, output: 0, cached: 0, total: 0 },
      calls: 0,
      invocations: [],
      startedAt: timestamp,
      observedAt: timestamp,
      completedAt: 0,
    });
    return turns.get(id);
  };
  const addInvocation = (turn, invocation) => {
    if (!turn || !invocation) return;
    const key = invocation.invocationId || JSON.stringify(invocation);
    if (!turn.invocations.some((item) => (item.invocationId || JSON.stringify(item)) === key)) turn.invocations.push(invocation);
  };
  try {
    for await (const line of reader) {
      const event = safeJsonParse(line, null);
      if (!event || typeof event !== "object") continue;
      const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
      if (event.type === "session_meta") {
        sessionId = String(payload.id || payload.session_id || "").trim();
        originator = String(payload.originator || "").trim();
        source = String(payload.source || "").trim();
        for (const turn of turns.values()) {
          turn.sessionKey = sessionId || turn.sessionKey;
          turn.threadKey = turn.sessionKey;
          turn.platform = originator || source || turn.platform;
        }
        continue;
      }
      if (!sessionId) {
        sessionId = String(payload.session_id || payload.sessionId || "").trim();
        if (sessionId) for (const turn of turns.values()) {
          turn.sessionKey = sessionId;
          turn.threadKey = sessionId;
        }
      }
      const eventType = payload.type || "";
      if (event.type === "turn_context" || (event.type === "event_msg" && eventType === "task_started")) {
        currentTurnId = String(payload.turn_id || payload.turnId || currentTurnId).trim();
        const turn = ensureTurn(currentTurnId, sessionTimestamp(payload.started_at || event.timestamp));
        if (turn) {
          turn.startedAt = Math.min(turn.startedAt || Date.now(), sessionTimestamp(payload.started_at || event.timestamp));
          turn.model = String(payload.model || payload.model_name || payload.modelName || turn.model || "未知").trim() || "未知";
          turn.effort = String(payload.reasoning_effort || payload.reasoningEffort || payload.effort || turn.effort || "").trim();
          const tier = String(payload.service_tier || payload.serviceTier || payload.speed_tier || "").toLowerCase();
          if (typeof payload.fast_mode === "boolean") turn.fastMode = payload.fast_mode;
          else if (typeof payload.fastMode === "boolean") turn.fastMode = payload.fastMode;
          else if (tier) turn.fastMode = ["fast", "fast_mode", "priority"].includes(tier.replace(/[\s-]+/g, "_"));
        }
      }
      if (event.type === "event_msg" && eventType === "task_complete") {
        const turn = ensureTurn(payload.turn_id || payload.turnId || currentTurnId, event.timestamp);
        if (turn) turn.completedAt = sessionTimestamp(payload.completed_at || payload.completedAt || event.timestamp);
      }
      const eventTurnId = String(payload.turn_id || payload.turnId || payload.info?.turn_id || payload.info?.turnId || currentTurnId).trim();
      if (event.type === "event_msg" && eventType === "token_count") {
        const turn = ensureTurn(eventTurnId, event.timestamp);
        const cumulativeUsage = payload.info?.total_token_usage || payload.info?.totalTokenUsage;
        const usage = cumulativeUsage || payload.info?.last_token_usage || payload.info?.lastTokenUsage;
        if (usage && typeof usage === "object") {
          const delta = cumulativeUsage ? sessionUsageDelta(previousUsage, cumulativeUsage) : {
            input_tokens: Math.max(0, Number(usage.input_tokens || 0)),
            output_tokens: Math.max(0, Number(usage.output_tokens || 0)),
            cached_input_tokens: Math.max(0, Number(usage.cached_input_tokens || 0)),
            cache_write_input_tokens: Math.max(0, Number(usage.cache_write_input_tokens || 0)),
            total_tokens: Math.max(0, Number(usage.total_tokens || 0)),
          };
          if (cumulativeUsage) previousUsage = { ...cumulativeUsage };
          if (turn) {
            turn.usage.input += delta.input_tokens;
            turn.usage.output += delta.output_tokens;
            turn.usage.cached += delta.cached_input_tokens;
            turn.usage.total = turn.usage.input + turn.usage.output;
            turn.cacheWriteTokens = (turn.cacheWriteTokens || 0) + delta.cache_write_input_tokens;
            turn.calls += delta.total_tokens > 0 ? 1 : 0;
            turn.observedAt = sessionTimestamp(event.timestamp, turn.observedAt);
          }
        }
      }
      const turn = ensureTurn(eventTurnId, event.timestamp);
      if (event.type === "event_msg" && eventType === "mcp_tool_call_end") addInvocation(turn, sessionInvocation(payload.invocation || payload));
      if (event.type === "response_item" && eventType === "custom_tool_call") {
        for (const invocation of sessionSkillInvocations(payload)) addInvocation(turn, invocation);
      }
      if (eventType.includes("skill")) {
        for (const invocation of sessionSkillInvocations(payload)) addInvocation(turn, invocation);
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  if (!SUPPORTED_CODEX_ORIGINATORS.has(originator)) return [];
  return Array.from(turns.values())
    .filter((turn) => turn.usage.total > 0 || turn.invocations.length > 0)
    .map((turn) => ({
      ...turn,
      createdAt: new Date(turn.startedAt || turn.observedAt).toISOString(),
      startedAt: new Date(turn.startedAt || turn.observedAt).toISOString(),
      finishedAt: new Date(turn.completedAt || turn.observedAt).toISOString(),
      durationMs: Math.max(0, (turn.completedAt || turn.observedAt) - (turn.startedAt || turn.observedAt)),
      durationSec: Math.round(Math.max(0, (turn.completedAt || turn.observedAt) - (turn.startedAt || turn.observedAt)) / 1000),
      callCount: Math.max(1, turn.calls),
      ...(turn.cacheWriteTokens > 0 ? { cacheWriteTokens: turn.cacheWriteTokens, cacheWriteAvailable: true } : {}),
    }));
}

async function collectCodexSessionTurns(options = {}) {
  const sessionsPath = options.codexSessionsPath || DEFAULT_CODEX_SESSIONS_PATH;
  if (!fs.existsSync(sessionsPath)) return { ok: true, source: "codex-session", sessions_path: sessionsPath, turns: [], imported: 0, skipped: 0, error: "missing_sessions" };
  const cachePath = options.codexSessionsCachePath || `${options.dbPath || DEFAULT_DB_PATH}.sessions.json`;
  const oldCache = readJson(cachePath, { version: CODEX_SESSION_CACHE_VERSION, files: {} });
  const reusableCache = oldCache.version === CODEX_SESSION_CACHE_VERSION ? oldCache : { files: {} };
  const nextFiles = {};
  let reparsed = 0;
  for (const filePath of await listJsonlFiles(sessionsPath)) {
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch { continue; }
    const key = path.resolve(filePath);
    const cached = reusableCache.files?.[key];
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && Array.isArray(cached.turns)) {
      nextFiles[key] = cached;
      continue;
    }
    nextFiles[key] = { size: stat.size, mtimeMs: stat.mtimeMs, turns: await parseCodexSessionFile(filePath) };
    reparsed += 1;
  }
  const cachePayload = { version: CODEX_SESSION_CACHE_VERSION, updated_at: new Date().toISOString(), files: nextFiles };
  if (Buffer.byteLength(JSON.stringify(cachePayload)) <= CODEX_SESSION_CACHE_MAX_BYTES) writeJson(cachePath, cachePayload);
  const byTurnId = new Map();
  for (const turn of Object.values(nextFiles).flatMap((entry) => entry.turns || [])) {
    if (!SUPPORTED_CODEX_ORIGINATORS.has(turn.platform)) continue;
    const sessionKey = `${turn.platform || "codex"}:${turn.sessionKey || "unknown"}:${turn.turnId}`;
    const previous = byTurnId.get(sessionKey);
    if (!previous) {
      byTurnId.set(sessionKey, turn);
      continue;
    }
    const preferred = turn.usage.total >= previous.usage.total ? turn : previous;
    const other = preferred === turn ? previous : turn;
    const startedAt = String(preferred.startedAt) < String(other.startedAt) ? preferred.startedAt : other.startedAt;
    const finishedAt = String(preferred.finishedAt) > String(other.finishedAt) ? preferred.finishedAt : other.finishedAt;
    const invocationMap = new Map();
    for (const invocation of [...(preferred.invocations || []), ...(other.invocations || [])]) {
      invocationMap.set(invocation.invocationId || JSON.stringify(invocation), invocation);
    }
    byTurnId.set(sessionKey, {
      ...preferred,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      durationSec: Math.round(Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
      callCount: Math.max(preferred.callCount || 0, other.callCount || 0),
      usage: {
        input: Math.max(preferred.usage?.input || 0, other.usage?.input || 0),
        output: Math.max(preferred.usage?.output || 0, other.usage?.output || 0),
        cached: Math.max(preferred.usage?.cached || 0, other.usage?.cached || 0),
        total: Math.max(preferred.usage?.input || 0, other.usage?.input || 0) + Math.max(preferred.usage?.output || 0, other.usage?.output || 0),
      },
      cacheWriteTokens: Math.max(preferred.cacheWriteTokens || 0, other.cacheWriteTokens || 0),
      invocations: Array.from(invocationMap.values()),
    });
  }
  const turns = Array.from(byTurnId.values()).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.turnId.localeCompare(right.turnId));
  return { ok: true, source: "codex-session", sessions_path: sessionsPath, turns, imported: turns.length, skipped: 0, reparsed, updated_at: new Date().toISOString() };
}

function runPython(script, dbPath, options = {}, executable = process.env.PYTHON || "python") {
  const timeoutMs = Math.max(1, Number(options.pythonTimeoutMs || PYTHON_TIMEOUT_MS));
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child?.kill();
    }, timeoutMs);
    try {
      child = spawn(executable, ["-", dbPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, error: error?.message || "python_spawn_failed" });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > PYTHON_MAX_BUFFER) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > PYTHON_MAX_BUFFER) {
        outputTooLarge = true;
        child.kill();
        return;
      }
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (!process.env.PYTHON && executable === "python" && error?.code === "ENOENT") {
        clearTimeout(timeout);
        runPython(script, dbPath, options, "python3").then(resolve);
        settled = true;
        return;
      }
      finish({ ok: false, error: error?.message || "python_spawn_failed" });
    });
    child.on("close", (status) => {
      if (timedOut) {
        finish({ ok: false, error: `python_timeout_${timeoutMs}ms` });
        return;
      }
      if (outputTooLarge) {
        finish({ ok: false, error: "python_output_too_large" });
        return;
      }
      finish({ ok: status === 0, status, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

async function collectCcSwitchTurns(options = {}) {
  const dbPath = options.ccSwitchDbPath || DEFAULT_CC_SWITCH_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { ok: true, source: "cc-switch", db_path: dbPath, turns: [], imported: 0, skipped: 0, error: "missing_db" };
  }
  const script = String.raw`
import json, sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
cur = con.cursor()
def table_exists(name):
    return cur.execute("select 1 from sqlite_master where type = 'table' and name = ?", (name,)).fetchone() is not None

turns = []
rollup_max_date = None
rollup_rows = []
proxy_rows = []

if table_exists("usage_daily_rollups"):
    rollup_rows = cur.execute("""
    select
      date as day,
      date || 'T12:00:00.000Z' as bucket_at,
      'day' as time_granularity,
      coalesce(nullif(model, ''), nullif(request_model, ''), 'unknown') as model,
      coalesce(request_model, '') as request_model,
      coalesce(pricing_model, '') as pricing_model,
      sum(coalesce(request_count, success_count, 0)) as request_count,
      sum(coalesce(input_tokens, 0)) as input_tokens,
      sum(coalesce(output_tokens, 0)) as output_tokens,
      sum(coalesce(cache_read_tokens, 0)) as cached_tokens,
      sum(coalesce(cache_creation_tokens, 0)) as cache_write_tokens,
      sum(cast(coalesce(total_cost_usd, '0') as real)) as total_cost_usd,
      0 as duration_ms
    from usage_daily_rollups
    where app_type = 'codex' or provider_id = '_codex_session'
    group by day, model, request_model, pricing_model
    order by day, model, request_model, pricing_model
    """).fetchall()
    max_row = cur.execute("""
      select max(date) as day
      from usage_daily_rollups
      where app_type = 'codex' or provider_id = '_codex_session'
    """).fetchone()
    rollup_max_date = max_row["day"] if max_row else None

if table_exists("proxy_request_logs"):
    proxy_rows = cur.execute("""
    select
      date(created_at, 'unixepoch') as day,
      strftime('%Y-%m-%dT%H:00:00.000Z', created_at, 'unixepoch') as bucket_at,
      'hour' as time_granularity,
      coalesce(nullif(model, ''), nullif(request_model, ''), 'unknown') as model,
      coalesce(request_model, '') as request_model,
      coalesce(pricing_model, '') as pricing_model,
      count(*) as request_count,
      sum(coalesce(input_tokens, 0)) as input_tokens,
      sum(coalesce(output_tokens, 0)) as output_tokens,
      sum(coalesce(cache_read_tokens, 0)) as cached_tokens,
      sum(coalesce(cache_creation_tokens, 0)) as cache_write_tokens,
      sum(cast(coalesce(total_cost_usd, '0') as real)) as total_cost_usd,
      max(coalesce(duration_ms, latency_ms, 0)) as duration_ms
    from proxy_request_logs
    where
      (app_type = 'codex' or data_source = 'codex_session' or provider_id = '_codex_session' or provider_type = 'codex_session')
      and coalesce(status_code, 0) between 200 and 299
      and (? is null or date(created_at, 'unixepoch') > ?)
    group by day, bucket_at, model, request_model, pricing_model
    order by bucket_at, model, request_model, pricing_model
    """, (rollup_max_date, rollup_max_date)).fetchall()

for row in list(rollup_rows) + list(proxy_rows):
    day = row["day"] or "1970-01-01"
    bucket_at = row["bucket_at"] or day + "T12:00:00.000Z"
    time_granularity = row["time_granularity"] or "day"
    model = row["model"] or "unknown"
    request_model = row["request_model"] or ""
    pricing_model = row["pricing_model"] or ""
    input_tokens = int(row["input_tokens"] or 0)
    output_tokens = int(row["output_tokens"] or 0)
    cached_tokens = int(row["cached_tokens"] or 0)
    cache_write_tokens = int(row["cache_write_tokens"] or 0)
    total = input_tokens + output_tokens
    if total <= 0:
        continue
    key = ":".join([day if time_granularity == "day" else bucket_at, model, request_model, pricing_model])
    usage = {
        "input": input_tokens,
        "output": output_tokens,
        "cached": cached_tokens,
        "total": total,
    }
    if cache_write_tokens > 0:
        usage["cacheWriteTokens"] = cache_write_tokens
    turns.append({
        "turnId": "cc-switch:" + key,
        "source": "cc-switch",
        "importSource": "cc-switch",
        "model": model,
        "request_model": request_model,
        "pricing_model": pricing_model,
        "createdAt": bucket_at,
        "timeGranularity": time_granularity,
        "cacheWriteAvailable": cache_write_tokens > 0,
        "callCount": int(row["request_count"] or 0),
        "usage": usage,
        "costUsd": float(row["total_cost_usd"] or 0),
        "durationMs": int(row["duration_ms"] or 0),
        "durationSec": int(round((row["duration_ms"] or 0) / 1000)),
    })
print(json.dumps({
    "turns": turns,
    "metadata": {
        "rollup_rows": len(rollup_rows),
        "proxy_rows": len(proxy_rows),
        "rollup_max_date": rollup_max_date,
    },
}, ensure_ascii=False))
con.close()
`;
  const result = await runPython(script, dbPath, options);
  if (!result.ok) {
    return {
      ok: false,
      source: "cc-switch",
      db_path: dbPath,
      turns: [],
      imported: 0,
      skipped: 0,
      error: normalizeText(result.stderr || result.error || "python_sqlite_failed", 500),
    };
  }
  const parsed = safeJsonParse(result.stdout, {});
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  return {
    ok: true,
    source: "cc-switch",
    db_path: dbPath,
    turns,
    imported: turns.length,
    skipped: 0,
    metadata,
    updated_at: new Date().toISOString(),
  };
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1";
}

function ccSwitchStatus(options = {}) {
  const dbPath = options.ccSwitchDbPath || DEFAULT_CC_SWITCH_DB_PATH;
  return {
    ok: true,
    source: "codex-local-usage-helper",
    bridge: "cc-switch",
    db_path: dbPath,
    available: fs.existsSync(dbPath),
    profile_authority: "userscript-profile-ledger",
    profile_stats: "unsupported",
    updated_at: new Date().toISOString(),
  };
}

function isAllowedOrigin(origin) {
  const text = normalizeText(origin, 300);
  if (!text) return true;
  if (text === "null") return false;
  if (text === "app://-" || text.startsWith("app://-/")) return true;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function corsOrigin(origin) {
  const text = normalizeText(origin, 300);
  return text && isAllowedOrigin(text) ? text : "*";
}

function sendJson(res, status, body, origin = "") {
  res.writeHead(status, {
    "access-control-allow-origin": corsOrigin(origin),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function startServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  if (!isLoopbackHost(host)) throw new Error("Helper host must be a loopback address: 127.0.0.1 or ::1");
  const port = Number(options.port || DEFAULT_PORT);
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  let cached = readJson(dbPath, null);
  let cachedAt = cached?.updated_at ? Date.parse(cached.updated_at) : 0;
  let ccSwitchCached = null;
  let ccSwitchCachedAt = 0;
  let ccSwitchRefreshing = false;
  let codexSessionsCached = null;
  let codexSessionsCachedAt = 0;
  let codexSessionsRefreshing = false;
  const refreshCcSwitch = () => {
    if (ccSwitchRefreshing) return;
    ccSwitchRefreshing = true;
    if (typeof options.onCcSwitchRefresh === "function") options.onCcSwitchRefresh();
    setTimeout(async () => {
      try {
        ccSwitchCached = await collectCcSwitchTurns(options);
        ccSwitchCachedAt = Date.now();
        writeJson(dbPath, { ...ccSwitchStatus(options), cc_switch: ccSwitchCached });
      } catch (error) {
        ccSwitchCached = {
          ok: false,
          source: "cc-switch",
          db_path: options.ccSwitchDbPath || DEFAULT_CC_SWITCH_DB_PATH,
          turns: [],
          imported: 0,
          skipped: 0,
          error: normalizeText(error?.message || String(error), 500),
          updated_at: new Date().toISOString(),
        };
        ccSwitchCachedAt = Date.now();
      } finally {
        ccSwitchRefreshing = false;
      }
    }, Number(options.ccSwitchRefreshDelayMs || 0));
  };
  const refreshCodexSessions = () => {
    if (codexSessionsRefreshing) return;
    codexSessionsRefreshing = true;
    setTimeout(async () => {
      try {
        codexSessionsCached = await collectCodexSessionTurns(options);
        codexSessionsCachedAt = Date.now();
      } catch (error) {
        codexSessionsCached = {
          ok: false,
          source: "codex-session",
          sessions_path: options.codexSessionsPath || DEFAULT_CODEX_SESSIONS_PATH,
          turns: [],
          imported: 0,
          skipped: 0,
          error: normalizeText(error?.message || String(error), 500),
          updated_at: new Date().toISOString(),
        };
        codexSessionsCachedAt = Date.now();
      } finally {
        codexSessionsRefreshing = false;
      }
    }, Number(options.codexSessionsRefreshDelayMs || 0));
  };
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || "";
    const url = new URL(req.url || "/", "http://localhost");
    const protectedPath = url.pathname === "/stats" || url.pathname === "/cc-switch/turns" || url.pathname === "/codex-sessions/turns";
    if (protectedPath && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: "forbidden_origin" }, origin);
      return;
    }
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {}, origin);
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, source: "codex-local-usage-helper", bridge: "cc-switch" }, origin);
      return;
    }
    if (url.pathname === "/stats") {
      const status = ccSwitchStatus(options);
      sendJson(res, 200, {
        ...status,
        cached: Boolean(cached?.cc_switch?.ok),
        refreshing: ccSwitchRefreshing,
        codex_sessions_available: fs.existsSync(options.codexSessionsPath || DEFAULT_CODEX_SESSIONS_PATH),
        codex_sessions_cached: Boolean(codexSessionsCached?.ok),
        codex_sessions_refreshing: codexSessionsRefreshing,
      }, origin);
      return;
    }
    if (url.pathname === "/cc-switch/turns") {
      const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
      const cacheTtl = ccSwitchCached?.ok && !ccSwitchCached?.error ? CC_SWITCH_CACHE_TTL_MS : CC_SWITCH_ERROR_CACHE_TTL_MS;
      const stale = !ccSwitchCached || !ccSwitchCachedAt || Date.now() - ccSwitchCachedAt > cacheTtl;
      if (forceRefresh || stale) refreshCcSwitch();
      const payload = ccSwitchCached || {
        ok: true,
        source: "cc-switch",
        db_path: options.ccSwitchDbPath || DEFAULT_CC_SWITCH_DB_PATH,
        turns: [],
        imported: 0,
        skipped: 0,
      };
      sendJson(res, ccSwitchCached?.ok ? 200 : 202, { ...payload, refreshing: ccSwitchRefreshing }, origin);
      return;
    }
    if (url.pathname === "/codex-sessions/turns") {
      const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
      const stale = !codexSessionsCached || !codexSessionsCachedAt || Date.now() - codexSessionsCachedAt > CODEX_SESSION_CACHE_TTL_MS;
      if (forceRefresh || stale) refreshCodexSessions();
      const payload = codexSessionsCached || {
        ok: true,
        source: "codex-session",
        sessions_path: options.codexSessionsPath || DEFAULT_CODEX_SESSIONS_PATH,
        turns: [],
        imported: 0,
        skipped: 0,
      };
      sendJson(res, codexSessionsCached?.ok ? 200 : 202, { ...payload, refreshing: codexSessionsRefreshing }, origin);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" }, origin);
  });
  server.listen(port, host, () => {
    console.log(`codex-local-usage-helper listening on http://${host}:${port}`);
  });
  return server;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--host") options.host = argv[++i];
    else if (arg === "--db") options.dbPath = argv[++i];
    else if (arg === "--cc-switch-db") options.ccSwitchDbPath = argv[++i];
    else if (arg === "--codex-sessions") options.codexSessionsPath = argv[++i];
    else if (arg === "--serve") options.serve = true;
  }
  return options;
}

module.exports = {
  collectCodexSessionTurns,
  collectCcSwitchTurns,
  ccSwitchStatus,
  isLoopbackHost,
  runPython,
  startServer,
};

if (require.main === module) startServer(parseArgs(process.argv.slice(2)));
