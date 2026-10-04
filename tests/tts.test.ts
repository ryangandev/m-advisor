import assert from "node:assert/strict";
import { test } from "node:test";
import { generateTTS } from "../src/utils/tts";

test("speech text must be nonempty and at most 1000 characters before the model is used", async () => {
  await assert.rejects(generateTTS(""), /empty/);
  await assert.rejects(generateTTS("   "), /empty/);
  await assert.rejects(generateTTS("长".repeat(1001)), /1000/);
});
