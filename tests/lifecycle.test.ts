import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

// Exercise the source entry point while every Discord/model/database boundary
// is stubbed before it loads. No tokens, network calls or GPU imports are used.
function runStartupScenario(
  scenario: "before-commands" | "during-commands" | "during-login",
  failures: { client?: boolean; connection?: boolean } = {},
): string[] {
  const root = path.resolve(__dirname, "..");
  const code = String.raw`
const root = ${JSON.stringify(root)};
const scenario = ${JSON.stringify(scenario)};
const failures = ${JSON.stringify(failures)};
const Module = require("node:module");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const originalLoad = Module._load;
const originalRead = fs.readdirSync;
const trace = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class FakeClient extends EventEmitter {
  async login() {
    trace.push("login-begin");
    if (scenario === "during-login") process.emit("SIGTERM");
    await delay(30);
    trace.push("login-end");
    return "fake";
  }
  async destroy() {
    trace.push("destroy-begin");
    await delay(15);
    if (failures.client) {
      trace.push("destroy-failed");
      throw new Error("offline client destruction failure");
    }
    trace.push("destroy-end");
  }
}
process.env.DISCORD_TOKEN = "offline-test-token";
fs.readdirSync = (target, ...args) => String(target) === root + "/src/events" ? [] : originalRead(target, ...args);
Module._load = function(request, parent, ...args) {
  if (parent?.filename === root + "/src/index.ts") {
    const overrides = {
      "dotenv": { config: () => {} },
      "discord.js": { Client: FakeClient, Collection: Map, GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2 } },
      "./handlers/commandHandler": { loadCommands: async () => {
        trace.push("commands-begin");
        if (scenario === "during-commands") process.emit("SIGTERM");
        await delay(30);
        trace.push("commands-end");
      } },
      "./services/riotData": { getRiotMode: () => "mock" },
      "./services/gameMonitor": { stopAllPolling: () => trace.push("stop-monitoring") },
      "./utils/tts": { shutdownTTS: async () => trace.push("stop-speech") },
      "./store/database": { closeDatabase: () => trace.push("close-database") },
      "@discordjs/voice": { getVoiceConnections: () => new Map([
        ["first", { destroy: () => {
          trace.push("first-connection-destroy");
          if (failures.connection) throw new Error("offline connection destruction failure");
        } }],
        ["second", { destroy: () => trace.push("second-connection-destroy") }],
      ]) },
    };
    if (overrides[request]) return overrides[request];
  }
  return originalLoad.call(this, request, parent, ...args);
};
require(root + "/src/index.ts");
if (scenario === "before-commands") process.emit("SIGTERM");
setTimeout(() => console.log(JSON.stringify({ trace })), 150);
`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, failures.client || failures.connection ? 1 : 0, child.stderr);
  const output = child.stdout;
  const result = output.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return undefined; }
  }).find((item) => item?.trace);
  assert.ok(result, output);
  return result.trace;
}

for (const scenario of ["before-commands", "during-commands"] as const) {
  test(`SIGTERM ${scenario} prevents later login and waits for client destruction`, () => {
    const trace = runStartupScenario(scenario);
    assert.ok(!trace.includes("login-begin"), trace.join(", "));
    assert.ok(trace.indexOf("destroy-end") < trace.indexOf("stop-speech"), trace.join(", "));
    assert.ok(trace.indexOf("stop-speech") < trace.indexOf("close-database"), trace.join(", "));
    assert.equal(trace.filter((entry) => entry === "stop-monitoring").length, 1);
  });
}

test("SIGTERM during login destroys the client again if login completes after stopping", () => {
  const trace = runStartupScenario("during-login");
  assert.ok(trace.includes("login-begin"));
  assert.ok(trace.includes("login-end"));
  assert.equal(trace.filter((entry) => entry === "destroy-end").length, 2, trace.join(", "));
  assert.equal(trace.filter((entry) => entry === "close-database").length, 1);
});

test("client destruction failure still shuts down speech and closes the database with failure status", () => {
  const trace = runStartupScenario("before-commands", { client: true });
  assert.ok(trace.includes("destroy-failed"));
  assert.ok(trace.indexOf("destroy-failed") < trace.indexOf("stop-speech"));
  assert.ok(trace.indexOf("stop-speech") < trace.indexOf("close-database"));
});

test("one voice connection destruction failure does not skip other connections or remaining resources", () => {
  const trace = runStartupScenario("before-commands", { connection: true });
  assert.ok(trace.includes("first-connection-destroy"));
  assert.ok(trace.includes("second-connection-destroy"));
  assert.ok(trace.includes("destroy-end"));
  assert.ok(trace.includes("stop-speech"));
  assert.ok(trace.includes("close-database"));
});

test("ready event does not prewarm speech after restoration races with shutdown", () => {
  const root = path.resolve(__dirname, "..");
  const code = String.raw`
const root = ${JSON.stringify(root)};
const Module = require("node:module");
const originalLoad = Module._load;
const stopping = require(root + "/src/services/shutdownState.ts");
const trace = [];
Module._load = function(request, parent, ...args) {
  if (parent?.filename === root + "/src/events/ready.ts") {
    const overrides = {
      "discord.js": { Events: { ClientReady: "ready" } },
      "../services/monitorLifecycle": { restoreMonitoring: async () => {
        trace.push("restore-monitoring");
        stopping.beginShutdown();
        await Promise.resolve();
      } },
      "../services/riotData": { getRiotDataLabel: () => "mock" },
      "../utils/tts": { prewarmTTS: async () => trace.push("prewarm") },
    };
    if (overrides[request]) return overrides[request];
  }
  return originalLoad.call(this, request, parent, ...args);
};
require(root + "/src/events/ready.ts").default.execute({ user: { tag: "offline-test" } })
  .then(() => console.log(JSON.stringify({ trace })));
`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.deepEqual(result.trace, ["restore-monitoring"]);
});

test("beginShutdown prevents playback when in-flight local speech completes", () => {
  const root = path.resolve(__dirname, "..");
  const code = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const { LOCAL_TTS_MODEL } = require(root + "/src/services/localTts.ts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m-advisor-shutdown-"));
// The fake worker answers only after the test releases it, so shutdown begins while speech is in flight.
fs.writeFileSync(path.join(dir, "worker.cjs"), [
  "const fs = require('node:fs');",
  "const dir = " + JSON.stringify(dir) + ";",
  "const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
  "emit({ event: 'ready', model: " + JSON.stringify(LOCAL_TTS_MODEL) + ", revision: 'test' });",
  "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const request = JSON.parse(line);",
  "  fs.appendFileSync(dir + '/requests', request.output + '\\n');",
  "  const timer = setInterval(() => {",
  "    if (!fs.existsSync(dir + '/release')) return;",
  "    clearInterval(timer);",
  "    const wav = Buffer.alloc(244); wav.write('RIFF', 0); wav.writeUInt32LE(236, 4); wav.write('WAVE', 8);",
  "    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);",
  "    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);",
  "    wav.write('data', 36); wav.writeUInt32LE(200, 40); wav.fill(10, 44);",
  "    fs.writeFileSync(request.output, wav);",
  "    emit({ id: request.id, ok: true, output: fs.realpathSync(request.output) });",
  "  }, 10);",
  "});",
].join("\n"));
fs.writeFileSync(path.join(dir, "model.json"), "{}");
Object.assign(process.env, { LOCAL_TTS_PYTHON: process.execPath, LOCAL_TTS_WORKER: path.join(dir, "worker.cjs"),
  LOCAL_TTS_MODEL_RECORD: path.join(dir, "model.json"), LOCAL_TTS_MEDIA_ROOT: dir });
const { beginShutdown } = require(root + "/src/services/shutdownState.ts");
const { generateTTS, shutdownTTS } = require(root + "/src/utils/tts.ts");
const { VoiceAnnouncementService } = require(root + "/src/services/voiceAnnouncements.ts");
let played = 0;
const requests = () => fs.existsSync(dir + "/requests") ? fs.readFileSync(dir + "/requests", "utf8").trim().split("\n") : [];
const service = new VoiceAnnouncementService({ generate: generateTTS,
  play: async () => { played++; }, cleanup: async () => {} });
(async () => {
  const pending = service.announce("guild", "等待关闭的语音测试", "old", () => ({ id: "voice", guild: { id: "guild" } }));
  const completed = pending.catch(error => error.message);
  while (requests().length === 0) await new Promise(resolve => setTimeout(resolve, 10));
  beginShutdown();
  fs.writeFileSync(dir + "/release", "1");
  const error = await completed;
  const future = await generateTTS("已经停止").catch(error => error.message);
  await shutdownTTS();
  const outputs = requests();
  console.log(JSON.stringify({ played, calls: outputs.length, error, future, outputLeft: outputs.some(file => fs.existsSync(file)) }));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "-e", code], { cwd: root, encoding: "utf8", timeout: 10_000 });
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.equal(result.played, 0);
  assert.equal(result.calls, 1);
  assert.match(result.error, /shut down/);
  assert.match(result.future, /shut down/);
  assert.equal(result.outputLeft, false, "late audio is deleted");
});
