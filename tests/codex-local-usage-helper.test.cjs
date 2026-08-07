const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const helper = require("../scripts/codex-local-usage-helper.cjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function requestJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 5000, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

async function waitForTurnCount(port, count) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await requestJson(port, "/cc-switch/turns");
    if (response.body.turns?.length === count && response.body.refreshing === false) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return requestJson(port, "/cc-switch/turns");
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cltc-helper-test-"));
  try {
    const ccSwitchDb = path.join(root, "cc-switch.db");
    const createDb = spawnSync("python", ["-", ccSwitchDb], {
      input: String.raw`
import sqlite3, sys
db=sys.argv[1]
con=sqlite3.connect(db)
cur=con.cursor()
cur.execute("""create table proxy_request_logs (
  request_id text primary key,
  provider_id text not null,
  app_type text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  total_cost_usd text not null default '0',
  latency_ms integer not null,
  duration_ms integer,
  status_code integer not null,
  session_id text,
  provider_type text,
  created_at integer not null,
  request_model text,
  data_source text not null default 'proxy',
  pricing_model text
)""")
cur.execute("""create table usage_daily_rollups (
  date text not null,
  app_type text,
  provider_id text,
  model text,
  request_model text,
  pricing_model text,
  request_count integer,
  success_count integer,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_creation_tokens integer,
  total_cost_usd text
)""")
cur.execute("insert into usage_daily_rollups values (?,?,?,?,?,?,?,?,?,?,?,?,?)", ('2026-07-03','codex','_codex_session','gpt-5.5','gpt-5.5','',4,4,1000,100,500,0,'10'))
rows=[
 ('r1','_codex_session','codex','gpt-5.5',100,20,40,0,'1.5',0,0,200,'s1','codex_session',1783152000,'gpt-5.5','codex_session',''),
 ('r2','_codex_session','codex','gpt-5.5',50,10,20,0,'0.5',0,0,200,'s1','codex_session',1783153800,'gpt-5.5','codex_session',''),
 ('other','other','gemini','gemini',999,999,0,0,'9',0,0,200,'s2','proxy',1783153800,'gemini','proxy',''),
]
cur.executemany("insert into proxy_request_logs values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
con.commit()
con.close()
`,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(createDb.status, 0, createDb.stderr);

    const ccSwitch = await helper.collectCcSwitchTurns({ ccSwitchDbPath: ccSwitchDb });
    assert.equal(ccSwitch.ok, true);
    assert.equal(ccSwitch.imported, 2);
    assert.deepEqual(
      ccSwitch.turns.map((turn) => turn.turnId),
      [
        "cc-switch:2026-07-03:gpt-5.5:gpt-5.5:",
        "cc-switch:2026-07-04T08:00:00.000Z:gpt-5.5:gpt-5.5:",
      ],
    );
    assert.equal(ccSwitch.turns[0].callCount, 4);
    assert.deepEqual(ccSwitch.turns[0].usage, { input: 1000, output: 100, cached: 500, total: 1100 });
    assert.equal(ccSwitch.turns[1].callCount, 2);
    assert.deepEqual(ccSwitch.turns[1].usage, { input: 150, output: 30, cached: 60, total: 180 });
    assert.equal(ccSwitch.turns[1].costUsd, 2);
    assert.equal(ccSwitch.turns[1].durationMs, 0);
    assert.equal(ccSwitch.metadata.rollup_rows, 1);
    assert.equal(ccSwitch.metadata.proxy_rows, 1);
    assert.equal(ccSwitch.metadata.rollup_max_date, "2026-07-03");
    assert.equal(ccSwitch.turns.every((turn) => turn.source === "cc-switch" && turn.importSource === "cc-switch"), true);
    assert.equal(ccSwitch.turns.some((turn) => Object.hasOwn(turn, "prompt") || Object.hasOwn(turn, "sessionKey")), false);
    assert.equal(typeof helper.collectStats, "undefined");
    assert.equal(typeof helper.collectThreadContent, "undefined");

    const missing = await helper.collectCcSwitchTurns({ ccSwitchDbPath: path.join(root, "missing.db") });
    assert.equal(missing.ok, true);
    assert.equal(missing.error, "missing_db");
    assert.deepEqual(missing.turns, []);
    const sessionsRoot = path.join(root, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const sessionFile = path.join(sessionsRoot, "sample.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-vscode", originator: "codex_vscode", source: "vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:00.000Z", model: "gpt-5.5", reasoning_effort: "medium", service_tier: "fast" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 0, total_tokens: 110 } } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 140, output_tokens: 15, cached_input_tokens: 30, cache_write_input_tokens: 2, total_tokens: 155 } } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { call_id: "mcp-1", server: "node_repl" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "exec-1", name: "exec", input: "rtk read C:/Users/x/.codex/skills/diagnose/SKILL.md" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "exec-helloagents", name: "exec", input: "rtk read C:/Users/x/.codex/plugins/cache/local-plugins/helloagents/4.0.3/skills/hello-debug/SKILL.md" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "skill_invocation", turn_id: "turn-1", call_id: "skill-1", skill_name: "hello-debug" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", completed_at: "2026-08-01T00:00:10.000Z" } }),
    ].join("\n"));
    fs.writeFileSync(path.join(sessionsRoot, "sample-partial.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "session-vscode", originator: "codex_vscode", source: "vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: "2026-08-01T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 5, total_tokens: 50 } } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "mcp_tool_call_end", invocation: { call_id: "mcp-2", server: "codegraph" } } }),
    ].join("\n"));
    fs.writeFileSync(path.join(sessionsRoot, "unsupported.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "session-cli", originator: "codex-tui", source: "cli" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-cli" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 999, output_tokens: 1, total_tokens: 1000 } } } }),
    ].join("\n"));
    const sessionStats = await helper.collectCodexSessionTurns({ codexSessionsPath: sessionsRoot, codexSessionsCachePath: path.join(root, "sessions-cache.json") });
    assert.equal(sessionStats.ok, true);
    assert.equal(sessionStats.turns.length, 1);
    assert.deepEqual(sessionStats.turns[0].usage, { input: 140, output: 15, cached: 30, total: 155 });
    assert.equal(sessionStats.turns[0].platform, "codex_vscode");
    assert.equal(sessionStats.turns[0].fastMode, true);
    assert.equal(sessionStats.turns[0].invocations.some((item) => item.plugin_id === "node_repl"), true);
    assert.equal(sessionStats.turns[0].invocations.some((item) => item.plugin_id === "codegraph"), true);
    assert.equal(sessionStats.turns[0].invocations.some((item) => item.skill_id === "diagnose"), true);
    assert.equal(sessionStats.turns[0].invocations.some((item) => item.skill_id === "hello-debug"), true);
    assert.equal(sessionStats.turns[0].invocations.find((item) => item.skill_id === "hello-debug")?.owner_plugin_id, "helloagents");
    const skillOnlyFile = path.join(sessionsRoot, "skill-only.jsonl");
    fs.writeFileSync(skillOnlyFile, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-skill-only", originator: "codex_vscode" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", turn_id: "skill-turn", call_id: "skill-exec", name: "exec", command: "codex skill hello-qa" } }),
    ].join("\n"));
    const duplicateTurnFile = path.join(sessionsRoot, "duplicate-turn.jsonl");
    fs.writeFileSync(duplicateTurnFile, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-other", originator: "codex_vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "mcp_tool_call_end", turn_id: "turn-1", invocation: { call_id: "mcp-other", server: "context7" } } }),
    ].join("\n"));
    fs.writeFileSync(path.join(sessionsRoot, "sample-complement.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "session-vscode", originator: "codex_vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 200, output_tokens: 1, cached_input_tokens: 2, total_tokens: 201 } } } }),
    ].join("\n"));
    const expandedStats = await helper.collectCodexSessionTurns({ codexSessionsPath: sessionsRoot, codexSessionsCachePath: path.join(root, "expanded-sessions-cache.json") });
    assert.equal(expandedStats.turns.length, 3);
    assert.equal(expandedStats.turns.some((turn) => turn.sessionKey === "session-skill-only" && turn.usage.total === 0), true);
    assert.equal(expandedStats.turns.some((turn) => turn.sessionKey === "session-other" && turn.turnId === "turn-1"), true);
    assert.deepEqual(expandedStats.turns.find((turn) => turn.sessionKey === "session-vscode").usage, { input: 200, output: 15, cached: 30, total: 215 });
    const cachedSessionStats = await helper.collectCodexSessionTurns({ codexSessionsPath: sessionsRoot, codexSessionsCachePath: path.join(root, "expanded-sessions-cache.json") });
    assert.equal(cachedSessionStats.reparsed, 0);
    const splitBaselineFile = path.join(sessionsRoot, "split-baseline.jsonl");
    fs.writeFileSync(splitBaselineFile, [
      JSON.stringify({ type: "session_meta", payload: { id: "session-split", originator: "codex_vscode" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "split-turn" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 10, total_tokens: 160 } } } }),
    ].join("\n"));
    const splitStats = await helper.collectCodexSessionTurns({ codexSessionsPath: sessionsRoot, codexSessionsCachePath: path.join(root, "split-baseline-cache.json") });
    const splitTurn = splitStats.turns.find((turn) => turn.sessionKey === "session-split");
    assert.deepEqual(splitTurn.usage, { input: 50, output: 10, cached: 0, total: 60 });
    assert.equal(helper.ccSwitchStatus({ ccSwitchDbPath: ccSwitchDb }).profile_authority, "userscript-profile-ledger");
    assert.equal(helper.isLoopbackHost("127.0.0.1"), true);
    assert.equal(helper.isLoopbackHost("::1"), true);
    assert.equal(helper.isLoopbackHost("localhost"), false);
    assert.throws(() => helper.startServer({ host: "0.0.0.0" }), /loopback/);

    let eventLoopTicked = false;
    const timedPython = helper.runPython("import time\ntime.sleep(1)\n", ccSwitchDb, { pythonTimeoutMs: 50 });
    await new Promise((resolve) => setTimeout(() => {
      eventLoopTicked = true;
      resolve();
    }, 10));
    assert.equal(eventLoopTicked, true);
    const timedPythonResult = await timedPython;
    assert.equal(timedPythonResult.ok, false);
    assert.equal(timedPythonResult.error, "python_timeout_50ms");

    const oversizedPythonResult = await helper.runPython('print("x" * (17 * 1024 * 1024))', ccSwitchDb);
    assert.equal(oversizedPythonResult.ok, false);
    assert.equal(oversizedPythonResult.error, "python_output_too_large");

    const helperSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "codex-local-usage-helper.cjs"), "utf8");
    assert.match(helperSource, /const PYTHON_TIMEOUT_MS = 30000;/);
    assert.match(helperSource, /new URL\(req\.url \|\| "\/", "http:\/\/localhost"\)/);

    const serverDb = path.join(root, "helper-meta.json");
    const port = await freePort();
    let refreshCount = 0;
    const server = helper.startServer({
      ccSwitchDbPath: ccSwitchDb,
      codexSessionsPath: sessionsRoot,
      codexSessionsCachePath: path.join(root, "server-sessions-cache.json"),
      dbPath: serverDb,
      port,
      ccSwitchRefreshDelayMs: 25,
      onCcSwitchRefresh() {
        refreshCount += 1;
      },
    });
    try {
      const stats = await requestJson(port, "/stats");
      assert.equal(stats.status, 200);
      assert.equal(stats.body.bridge, "cc-switch");
      assert.equal(stats.body.profile_authority, "userscript-profile-ledger");
      assert.equal(stats.body.codex_sessions_available, true);
      assert.equal(Object.hasOwn(stats.body, "stats"), false);
      assert.equal(Object.hasOwn(stats.body, "turns"), false);

      const blockedStats = await requestJson(port, "/stats", { Origin: "https://example.com" });
      assert.equal(blockedStats.status, 403);
      assert.equal(blockedStats.body.error, "forbidden_origin");
      const removedSessionEndpoint = await requestJson(port, "/codex/thread-content?threadId=thread-a");
      assert.equal(removedSessionEndpoint.status, 404);

      const first = await requestJson(port, "/cc-switch/turns?refresh=1");
      assert.equal(first.status, 202);
      assert.equal(first.body.refreshing, true);
      const concurrent = await Promise.all([
        requestJson(port, "/cc-switch/turns?refresh=1"),
        requestJson(port, "/cc-switch/turns?refresh=true"),
      ]);
      assert.equal(concurrent[0].body.refreshing, true);
      assert.equal(concurrent[1].body.refreshing, true);
      assert.equal(refreshCount, 1);
      const ready = await waitForTurnCount(port, 2);
      assert.equal(ready.status, 200);
      assert.equal(ready.body.turns.length, 2);
      assert.equal(ready.body.turns[1].durationSec, 0);
      assert.equal(Object.hasOwn(ready.body, "stats"), false);
      const sessionFirst = await requestJson(port, "/codex-sessions/turns?refresh=1");
      assert.equal(sessionFirst.status, 202);
      const sessionReady = await (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const response = await requestJson(port, "/codex-sessions/turns");
          if (response.body.turns?.length === 1 && response.body.refreshing === false) return response;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return requestJson(port, "/codex-sessions/turns");
      })();
      assert.equal(sessionReady.status, 200);
      assert.equal(sessionReady.body.turns[0].turnId, "turn-1");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const missingDb = path.join(root, "missing-cc-switch.db");
    const missingPort = await freePort();
    const missingServer = helper.startServer({ ccSwitchDbPath: missingDb, dbPath: path.join(root, "missing-meta.json"), port: missingPort });
    try {
      const firstMissing = await requestJson(missingPort, "/cc-switch/turns?refresh=1");
      assert.equal(firstMissing.body.refreshing, true);
      const missingReady = await waitForTurnCount(missingPort, 0);
      assert.equal(missingReady.status, 200);
      assert.equal(missingReady.body.error, "missing_db");
      fs.copyFileSync(ccSwitchDb, missingDb);
      await requestJson(missingPort, "/cc-switch/turns?refresh=1");
      const recovered = await waitForTurnCount(missingPort, 2);
      assert.equal(recovered.status, 200);
      assert.equal(recovered.body.turns.length, 2);
    } finally {
      await new Promise((resolve) => missingServer.close(resolve));
    }

    const launcher = fs.readFileSync(path.join(__dirname, "..", "scripts", "start-helper.ps1"), "utf8");
    assert.match(launcher, /\[ValidateSet\("127\.0\.0\.1", "::1"\)\]/);
    assert.match(launcher, /\[string\]\$ListenHost = "127\.0\.0\.1"/);
    assert.equal(/\[string\]\$Host\b/.test(launcher), false);
    assert.match(launcher, /\$helperArgument = '"' \+ \$helper \+ '"'/);
    assert.match(launcher, /-ArgumentList @\(\$helperArgument,/);
    assert.match(launcher, /"--host", \$ListenHost, "--port", \$Port/);
    assert.match(launcher, /Invoke-RestMethod[\s\S]*\/health/);
    assert.match(launcher, /\$health\.source -ne "codex-local-usage-helper"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("codex-local-usage-helper tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
