import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { checkTTS, generateTTS, shutdownTTS } from "../src/utils/tts";

async function withAzure(run: () => Promise<void>): Promise<void> {
  const before = { provider: process.env.TTS_PROVIDER, key: process.env.AZURE_TTS_KEY,
    region: process.env.AZURE_TTS_REGION, fetch: globalThis.fetch };
  process.env.TTS_PROVIDER = "azure";
  process.env.AZURE_TTS_KEY = "test-key";
  process.env.AZURE_TTS_REGION = "westus";
  try { await run(); }
  finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of Object.entries({ TTS_PROVIDER: before.provider,
      AZURE_TTS_KEY: before.key, AZURE_TTS_REGION: before.region })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("explicit Azure provider escapes SSML and uses the selected voice", async () => {
  await withAzure(async () => {
    let calls = 0;
    globalThis.fetch = (async (url, options) => {
      calls++;
      assert.equal(url, "https://westus.tts.speech.microsoft.com/cognitiveservices/v1");
      assert.match(String(options?.body), /zh-CN-YunxiNeural/);
      assert.match(String(options?.body), /&lt;朋友&gt; &amp; &quot;胜利&quot;/);
      assert.ok(options?.signal);
      return new Response(Buffer.from("fake-audio"));
    }) as typeof fetch;
    assert.deepEqual(await checkTTS(), { provider: "azure", ready: true });
    const output = await generateTTS('<朋友> & "胜利"', "old");
    assert.equal((await readFile(output)).toString(), "fake-audio");
    await rm(output);
    assert.equal(calls, 1);
  });
});

test("Azure failure is sanitized and does not silently fall back to local speech", async () => {
  await withAzure(async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("secret-key-and-private-transcript", { status: 400 });
    }) as typeof fetch;
    await assert.rejects(generateTTS("测试"), (error: Error) => {
      assert.equal(error.message, "Azure TTS request failed (400).");
      return true;
    });
    assert.equal(calls, 1);
  });
});

test("unknown provider and invalid Azure region fail without network requests", async () => {
  await withAzure(async () => {
    globalThis.fetch = (async () => { assert.fail("Unexpected network request"); }) as typeof fetch;
    process.env.TTS_PROVIDER = "unknown";
    await assert.rejects(generateTTS("测试"), /TTS_PROVIDER/);
    process.env.TTS_PROVIDER = "azure";
    process.env.AZURE_TTS_REGION = "westus/invalid";
    await assert.rejects(generateTTS("测试"), /valid key and region/);
    await assert.rejects(generateTTS(""), /empty/);
    await assert.rejects(generateTTS("长".repeat(1001)), /1000/);
  });
});

test("shutdown aborts in-flight Azure requests and rejects late completion and future speech", async () => {
  await withAzure(async () => {
    const signals: AbortSignal[] = [];
    const releases: Array<(response: Response) => void> = [];
    let releaseBody!: (audio: ArrayBuffer) => void;
    let bodyStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => { bodyStarted = resolve; });
    globalThis.fetch = (async (_url, options) => {
      const signal = options?.signal as AbortSignal;
      signals.push(signal);
      if (signals.length === 3) {
        const response = new Response("body-pending");
        response.arrayBuffer = async () => {
          bodyStarted();
          return new Promise<ArrayBuffer>((resolve) => { releaseBody = resolve; });
        };
        return response;
      }
      return new Promise<Response>((resolve, reject) => {
        if (signals.length === 1) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        // A transport that completes concurrently with cancellation must still
        // never create an audio file or resolve synthesis after shutdown.
        else releases.push(resolve);
      });
    }) as typeof fetch;
    const first = generateTTS("等待网络的第一条");
    const second = generateTTS("会晚到的第二条");
    const third = generateTTS("正在读取音频的第三条");
    const firstRejected = assert.rejects(first, /shut down/);
    const secondRejected = assert.rejects(second, /shut down/);
    const thirdRejected = assert.rejects(third, /shut down/);
    await readingBody;
    assert.equal(signals.length, 3);
    const stopped = shutdownTTS();
    assert.equal(shutdownTTS(), stopped);
    assert.ok(signals.every((signal) => signal.aborted));
    releases[0](new Response(Buffer.from("late-audio")));
    releaseBody(new ArrayBuffer(8));
    await Promise.all([stopped, firstRejected, secondRejected, thirdRejected]);
    let extraCalls = 0;
    globalThis.fetch = (async () => { extraCalls++; return new Response("unexpected"); }) as typeof fetch;
    await assert.rejects(generateTTS("已经停止"), /shut down/);
    await assert.rejects(checkTTS(), /shut down/);
    assert.equal(extraCalls, 0);
  });
});
