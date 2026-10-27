import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK_CHARACTERS, MIN_CHUNK_CHARACTERS, splitSpeech } from "../src/utils/speechChunks";

const REPORT = "模拟战报。MockWin这局赢了，打了30分钟。军师羽扇一挥，本局马匹鉴定如下。特等马，锤石，模拟队友四，9.9分。"
  + "上等马，阿狸，MockWin，9.4分。建议把模拟队友四直接打包送去职业赛场，青训都不用过。这匹马，军师亲自给你牵缰绳。";

test("a report splits at full stops into ordered chunks that rebuild the text", () => {
  const chunks = splitSpeech(REPORT);
  assert.deepEqual(chunks, [
    "模拟战报。MockWin这局赢了，打了30分钟。",
    "军师羽扇一挥，本局马匹鉴定如下。",
    "特等马，锤石，模拟队友四，9.9分。",
    "上等马，阿狸，MockWin，9.4分。",
    "建议把模拟队友四直接打包送去职业赛场，青训都不用过。",
    "这匹马，军师亲自给你牵缰绳。",
  ]);
  assert.equal(chunks.join(""), REPORT);
});

test("decimal scores never split a sentence", () => {
  assert.deepEqual(splitSpeech("下等马，奥恩，6.8分。没有马，金克丝，0.2分。"), ["下等马，奥恩，6.8分。", "没有马，金克丝，0.2分。"]);
});

test("exclamations, questions, semicolons, ellipses and closing quotes end sentences", () => {
  assert.deepEqual(splitSpeech("这波团战打得太漂亮了！你这是在干什么呢？先别急；军师还没说完……“此马封神。”最后还有一句话没有说完呢"), [
    "这波团战打得太漂亮了！",
    "你这是在干什么呢？先别急；",
    "军师还没说完……“此马封神。”",
    "最后还有一句话没有说完呢",
  ]);
});

test("short sentences join the next one so no chunk is a fragment", () => {
  const chunks = splitSpeech("好。很好。这一局打得非常漂亮。");
  assert.deepEqual(chunks, ["好。很好。这一局打得非常漂亮。"]);
  // A short final sentence joins the chunk before it.
  assert.deepEqual(splitSpeech("这一局打得非常漂亮。好！"), ["这一局打得非常漂亮。好！"]);
  for (const chunk of splitSpeech(REPORT)) assert.ok(chunk.length >= MIN_CHUNK_CHARACTERS, chunk);
});

test("long sentences split at clause marks and then at the hard limit", () => {
  const clause = "这一段话很长很长很长很长很长，";
  const sentence = `${clause.repeat(12)}结束。`;
  const chunks = splitSpeech(sentence);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), sentence);
  for (const chunk of chunks) assert.ok(chunk.length <= MAX_CHUNK_CHARACTERS, `${chunk.length} characters`);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.endsWith("，")), "breaks fall after clause marks");
  const unbroken = "长".repeat(200);
  assert.deepEqual(splitSpeech(unbroken).map((chunk) => chunk.length), [80, 80, 40]);
});

test("whitespace and line breaks are trimmed at chunk boundaries", () => {
  assert.deepEqual(splitSpeech("  第一行的内容都写在这里\n第二行的内容在这里。\n"), ["第一行的内容都写在这里", "第二行的内容在这里。"]);
});

test("empty and oversized speech is rejected before any request", () => {
  assert.throws(() => splitSpeech(""), /empty/);
  assert.throws(() => splitSpeech(" \n "), /empty/);
  assert.throws(() => splitSpeech("长".repeat(1001)), /1000/);
  assert.equal(splitSpeech("长".repeat(1000)).join("").length, 1000);
});
