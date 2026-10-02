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
    await shutdownTTS();
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
