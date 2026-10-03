import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOCAL_TTS_MODEL, LocalTtsService, localTtsOptions } from "../src/services/localTts";

const FAKE_WORKER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const mode = process.env.FAKE_TTS_MODE || "success";
if (process.env.DISCORD_TOKEN || process.env.RIOT_API_KEY || process.env.AZURE_TTS_KEY) {
  emit({event: "fatal"});
  process.exit(1);
}
if (mode === "fatal-once" && !fs.existsSync(process.env.FAKE_STAMP)) {
  fs.writeFileSync(process.env.FAKE_STAMP, "1");
  emit({event: "fatal", error: "configuration"});
  process.exit(1);
}
if (mode !== "startup-hang") {
  setTimeout(() => emit({event: "ready", model: ${JSON.stringify(LOCAL_TTS_MODEL)}, revision: "test-revision"}),
    Number(process.env.FAKE_READY_DELAY || 0));
}
let count = 0;
let running = false;
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  count++;
  if (running) { emit({id: request.id, ok: false, error: "parallel"}); return; }
  running = true;
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    pid: process.pid, speaker: request.speaker, text: request.text, output: request.output}) + "\n");
  if ((mode === "crash-once" || mode === "hang-once") && !fs.existsSync(process.env.FAKE_STAMP)) {
    fs.writeFileSync(process.env.FAKE_STAMP, "1");
    if (mode === "crash-once") process.exit(2);
    fs.writeFileSync(request.output + ".tmp", "partial-wave");
    return;
  }
  setTimeout(() => {
    running = false;
    if (mode === "error-once" && count === 1) {
      emit({id: request.id, ok: false, error: "generation", details: "secret-do-not-log"});
      return;
    }
    if (mode === "bad-protocol") { process.stdout.write("not-json\n"); return; }
    if (mode === "bad-audio") fs.writeFileSync(request.output, "invalid");
    else {
      const buffer = Buffer.alloc(244);
      buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
      buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
      buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(24000, 24); buffer.writeUInt32LE(48000, 28);
      buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write("data", 36);
      buffer.writeUInt32LE(200, 40); buffer.fill(10, 44); fs.writeFileSync(request.output, buffer);
    }
    emit({id: request.id, ok: true, output: mode === "bad-path" ? "/untrusted.wav" : fs.realpathSync(request.output)});
  }, Number(process.env.FAKE_DELAY || 15));
});
`;

async function fixture(env: NodeJS.ProcessEnv = {}, timeoutMs = 1_500, queueLimit = 8) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tts-test-"));
  const workerPath = path.join(directory, "worker.cjs");
  const modelRecord = path.join(directory, "model.json");
  const log = path.join(directory, "requests.jsonl");
  await Promise.all([writeFile(workerPath, FAKE_WORKER), writeFile(modelRecord, "{}")]);
  const service = new LocalTtsService({ pythonPath: process.execPath, workerPath,
    modelRecord, mediaRoot: directory, timeoutMs, queueLimit,
    workerEnv: { FAKE_LOG: log, FAKE_STAMP: path.join(directory, "stamp"), ...env } });
  return { service, directory, log,
    async cleanup() { await service.shutdown(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("local worker reuses one process, serializes concurrent requests and maps both voices", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.prewarm(), { provider: "local", ready: true,
      model: LOCAL_TTS_MODEL, revision: "test-revision" });
    const [sweet, old] = await Promise.all([f.service.generate("胜利啦", "sweet"), f.service.generate("下局加油", "old")]);
    assert.notEqual(sweet, old);
    assert.equal((await readFile(sweet)).toString("ascii", 0, 4), "RIFF");
    const requests = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((r) => r.speaker), ["Serena", "Uncle_Fu"]);
    await f.service.generate("默认军师");
    const afterDefault = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(afterDefault.length, 3);
    assert.equal(afterDefault[2].speaker, "Uncle_Fu", "an omitted style uses the default old voice");
    assert.equal(requests[0].pid, requests[1].pid);
    await f.service.shutdown();
    await assert.rejects(access(sweet));
    await assert.rejects(access(old));
    await assert.rejects(f.service.generate("再来一次"), /shut down/);
  } finally { await f.cleanup(); }
});

test("queue capacity includes requests waiting for model startup", async () => {
  const f = await fixture({ FAKE_READY_DELAY: "100" }, 1_500, 1);
  try {
    const first = f.service.generate("第一条");
    await assert.rejects(f.service.generate("第二条"), /queue is full/);
    await first;
  } finally { await f.cleanup(); }
});

test("a generation error is sanitized and the next queued request uses the same worker", async () => {
  const f = await fixture({ FAKE_TTS_MODE: "error-once" });
  try {
    const first = f.service.generate("失败场景");
    const second = f.service.generate("恢复场景");
    await assert.rejects(first, (error: Error) => {
      assert.match(error.message, /could not generate/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    await second;
    const lines = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].pid, lines[1].pid);
  } finally { await f.cleanup(); }
});

test("worker crash rejects queued work and the next request starts a fresh worker", async () => {
  const f = await fixture({ FAKE_TTS_MODE: "crash-once" });
  try {
    const failures = await Promise.allSettled([f.service.generate("第一次"), f.service.generate("排队中的")]);
    assert.ok(failures.every((r) => r.status === "rejected"));
    await f.service.generate("重试成功");
    const lines = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.notEqual(lines[0].pid, lines[1].pid);
  } finally { await f.cleanup(); }
});

test("an immediate retry after fatal startup cannot be rejected by a stale startup subscriber", async () => {
  const f = await fixture({ FAKE_TTS_MODE: "fatal-once" });
  try {
    const retry = f.service.generate("启动会失败").catch((error: Error) => {
      assert.match(error.message, /dependencies are unavailable/);
      return f.service.generate("立即重新启动");
    });
    await retry;
    const requests = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, "立即重新启动");
  } finally { await f.cleanup(); }
});

test("generation deadline stops a hung worker and permits a later retry", async () => {
  const f = await fixture({ FAKE_TTS_MODE: "hang-once" }, 2_000);
  try {
    await assert.rejects(f.service.generate("会超时"), /timed out/);
    const first = JSON.parse((await readFile(f.log, "utf8")).trim());
    await assert.rejects(access(`${first.output}.tmp`));
    await f.service.generate("重试成功");
    const lines = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.notEqual(lines[0].pid, lines[1].pid);
  } finally { await f.cleanup(); }
});

test("missing model metadata rejects current work and permits retry after configuration repair", async () => {
  const f = await fixture();
  try {
    const record = path.join(f.directory, "model.json");
    await rm(record);
    const retry = f.service.generate("缺少配置").catch(async (error: Error) => {
      assert.match(error.message, /dependencies are unavailable/);
      await writeFile(record, "{}");
      return f.service.generate("配置修好了");
    });
    await retry;
  } finally { await f.cleanup(); }
});

test("model startup has a deadline and shutdown rejects pending requests", async () => {
  const timed = await fixture({ FAKE_TTS_MODE: "startup-hang" }, 250);
  try { await assert.rejects(timed.service.prewarm(), /loading timed out/); }
  finally { await timed.cleanup(); }
  const f = await fixture({ FAKE_READY_DELAY: "500" });
  try {
    const pending = f.service.generate("排队");
    const rejection = assert.rejects(pending, /shut down/);
    await f.service.shutdown();
    await rejection;
  } finally { await f.cleanup(); }
});

for (const mode of ["bad-protocol", "bad-audio", "bad-path"]) {
  test(`${mode} is rejected without trusting worker output`, async () => {
    const f = await fixture({ FAKE_TTS_MODE: mode });
    try {
      await assert.rejects(f.service.generate("验证输出"), /invalid|unexpected/);
    } finally { await f.cleanup(); }
  });
}

test("configuration and empty or oversized input fail before spawning a worker", async () => {
  assert.throws(() => localTtsOptions({ LOCAL_TTS_TIMEOUT_MS: "0" }), /positive integer/);
  assert.throws(() => localTtsOptions({ LOCAL_TTS_QUEUE_LIMIT: "banana" }), /positive integer/);
  const f = await fixture();
  try {
    await assert.rejects(f.service.generate("  "), /empty/);
    await assert.rejects(f.service.generate("长".repeat(1001)), /1000/);
    await assert.rejects(access(f.log));
  } finally { await f.cleanup(); }
});

test("local speech subprocess does not inherit service credentials", async () => {
  const before = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = "test-secret";
  const f = await fixture();
  try { await f.service.generate("只传语音配置"); }
  finally {
    if (before === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = before;
    await f.cleanup();
  }
});
