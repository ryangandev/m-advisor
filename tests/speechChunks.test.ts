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

test("separators stay with the chunk before them and only the whole text is trimmed", () => {
  const text = "  第一行的内容都写在这里\n第二行的内容在这里。 第三句话也写得足够长了。\n";
  const chunks = splitSpeech(text);
  assert.deepEqual(chunks, ["第一行的内容都写在这里\n", "第二行的内容在这里。 ", "第三句话也写得足够长了。"]);
  assert.equal(chunks.join(""), text.trim());
});

test("ASCII end marks end a sentence only before whitespace or the end of the text", () => {
  // A name containing "!" stays inside its sentence.
  assert.deepEqual(splitSpeech("特等马，Faker!Fan，9.9分。上等马，李青，模拟队友二，8.5分。"),
    ["特等马，Faker!Fan，9.9分。", "上等马，李青，模拟队友二，8.5分。"]);
  // "?" before a space ends a sentence and keeps its space; a short one still joins the next sentence.
  assert.deepEqual(splitSpeech("Hi? There"), ["Hi? There"]);
  assert.deepEqual(splitSpeech("第一句话说得够长了吧? 第二句话也说得够长了吧"), ["第一句话说得够长了吧? ", "第二句话也说得够长了吧"]);
  assert.deepEqual(splitSpeech("参团率百分之94;峡谷110都没你出警快!"), ["参团率百分之94;峡谷110都没你出警快!"]);
});

test("a hard cut never divides a number or a Latin word", () => {
  const digits = "1234567890".repeat(3);
  const sentence = `${"长".repeat(70)}${digits}${"长".repeat(30)}`;
  const chunks = splitSpeech(sentence);
  assert.equal(chunks.join(""), sentence);
  assert.ok(chunks.some((chunk) => chunk.includes(digits)), "the digit run stays in one chunk");
  assert.equal(chunks[0], "长".repeat(70), "the cut moves back before the number");
  // A number longer than the limit stays whole rather than being divided.
  const long = "9".repeat(120);
  assert.deepEqual(splitSpeech(`得分${long}分`), [`得分${long}分`]);
  const decimal = `${"长".repeat(78)}9.9分${"长".repeat(20)}`;
  assert.ok(splitSpeech(decimal).some((chunk) => chunk.includes("9.9分")), "a decimal stays whole");
  const words = `${"长".repeat(76)}MockWin${"长".repeat(20)}`;
  assert.ok(splitSpeech(words).some((chunk) => chunk.includes("MockWin")), "a Latin word stays whole");
});

test("empty and oversized speech is rejected before any request", () => {
  assert.throws(() => splitSpeech(""), /empty/);
  assert.throws(() => splitSpeech(" \n "), /empty/);
  assert.throws(() => splitSpeech("长".repeat(1001)), /1000/);
  assert.equal(splitSpeech("长".repeat(1000)).join("").length, 1000);
});
