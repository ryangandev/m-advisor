import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ButtonStyle, MessageFlags } from "discord.js";
import whyCommand, { choiceName, whyDependencies } from "../src/commands/why";
import { isAppealClosed, reopenAppeal } from "../src/store/appealStore";
import { closeDatabase } from "../src/store/database";
import { eraseMemberHorseRecords, listHorseRecords } from "../src/store/horseRecordStore";
import type { HorseRecord } from "../src/store/horseRecordStore";
import { setMemberAccounts } from "../src/store/bindingStore";
import { appealCustomId, parseAppealCustomId } from "../src/utils/whyEmbed";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";
import { seededJungler, seededSupport } from "./helpers/verdicts";

const GUILD = "why-guild";
const NO_MENTIONS = { parse: [], roles: [], users: [], repliedUser: false };
let directory: string;
let saved: Record<string, string | undefined>;
const originalRenderer = whyDependencies.renderRadar;
let savedError: typeof console.error;
const errors: string[] = [];

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-why-"));
  saved = { DATABASE_PATH: process.env.DATABASE_PATH, RIOT_MODE: process.env.RIOT_MODE };
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
  process.env.RIOT_MODE = "real";
  savedError = console.error;
  errors.length = 0;
  console.error = (line: string) => { errors.push(String(line)); };
});

afterEach(() => {
  closeDatabase();
  whyDependencies.renderRadar = originalRenderer;
  console.error = savedError;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

interface EmbedJson { title?: string; description?: string; color?: number; image?: { url: string }; footer?: { text: string }; fields?: Array<{ name: string; value: string }> }
interface Payload {
  content?: string;
  flags?: number;
  allowedMentions?: unknown;
  embeds?: Array<{ toJSON: () => EmbedJson }>;
  files?: Array<{ name?: string; attachment: unknown }>;
  components?: Array<{ toJSON: () => { components: Array<{ custom_id: string; label: string; disabled?: boolean; style: number }> } }>;
}

const embedOf = (payload: Payload) => payload.embeds![0].toJSON();
const fieldText = (payload: Payload, name: string) => embedOf(payload).fields?.find((field) => field.name.startsWith(name))?.value;
const buttonOf = (payload: Payload) => payload.components![0].toJSON().components[0];

function seed(records: HorseRecord[]): void {
  recordTracked(records.map((record) => ({ ...record, guildId: GUILD })));
}

function command(options: { userId?: string; target?: string; match?: string | null; guild?: boolean } = {}) {
  const calls: Array<{ kind: string; payload?: Payload }> = [];
  const stub = {
    guildId: options.guild === false ? null : GUILD,
    user: { id: options.userId ?? "support-friend" },
    options: {
      getUser: () => options.target ? { id: options.target } : null,
      getString: () => options.match ?? null,
    },
    reply: async (payload: Payload) => { calls.push({ kind: "reply", payload }); },
    deferReply: async () => { calls.push({ kind: "defer" }); },
    editReply: async (payload: Payload) => { calls.push({ kind: "edit", payload }); },
  };
  return { stub: stub as unknown as Parameters<typeof whyCommand.execute>[0], calls };
}

function button(customId: string, userId: string, options: { failUpdate?: boolean } = {}) {
  const calls: Array<{ kind: string; payload: Payload }> = [];
  const stub = {
    customId,
    guildId: GUILD,
    user: { id: userId },
    reply: async (payload: Payload) => { calls.push({ kind: "reply", payload }); },
    update: async (payload: Payload) => {
      if (options.failUpdate) throw Object.assign(new Error("Unknown interaction"), { name: "DiscordAPIError" });
      calls.push({ kind: "update", payload });
    },
    followUp: async (payload: Payload) => { calls.push({ kind: "followUp", payload }); },
  };
  return { stub: stub as unknown as Parameters<NonNullable<typeof whyCommand.handleButton>>[0], calls };
}

function autocomplete(options: { userId?: string; target?: string; typed?: string; focused?: string } = {}) {
  const responses: Array<Array<{ name: string; value: string }>> = [];
  const stub = {
    guildId: GUILD,
    user: { id: options.userId ?? "support-friend" },
    options: {
      getFocused: () => ({ name: options.focused ?? "match", value: options.typed ?? "" }),
      get: (name: string) => name === "user" && options.target ? { value: options.target } : null,
    },
    respond: async (choices: Array<{ name: string; value: string }>) => { responses.push(choices); },
  };
  return { stub: stub as unknown as Parameters<NonNullable<typeof whyCommand.autocomplete>>[0], responses };
}

async function verdictFor(options: Parameters<typeof command>[0] = {}): Promise<Payload> {
  const { stub, calls } = command(options);
  await whyCommand.execute(stub);
  assert.deepEqual(calls.map((call) => call.kind), ["defer", "edit"], "a verdict is acknowledged, then rendered");
  return calls[1].payload!;
}

test("/why shows the caller's latest real verdict with the radar, the costliest dimensions and the gap", async () => {
  seed([seededSupport({ matchId: "NA1_OLDER", playedAt: 1_700_000_000_000, tier: "特等马" }), seededSupport()]);
  const payload = await verdictFor();
  const embed = embedOf(payload);
  assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
  assert.equal(payload.flags, undefined, "the verdict is public");
  assert.equal(embed.title, "判决书 · 策马军师");
  assert.equal(embed.image?.url, "attachment://why-verdict.png");
  assert.equal(payload.files?.[0].name, "why-verdict.png");
  assert.ok(Buffer.isBuffer(payload.files?.[0].attachment));
  assert.match(embed.description!, /^<@support-friend> · 锤石 · 辅助 · 负 · <t:\d+:R>\n🪦 \*\*没有马\*\* · \*\*1\.6\*\* 分 · 队内第 5\/5$/);
  const reasons = fieldText(payload, "拖后腿的维度")!.split("\n");
  assert.equal(reasons[0], "**视野** 超过 9% 的同位置玩家 · 占这局辅助评分 22% · 每分钟视野得分 0.8 · 插了 3 个真眼");
  assert.match(reasons[1], /^\*\*参团\*\* 超过 18%/);
  assert.match(reasons[2], /^\*\*功能\*\* 超过 22%/);
  assert.equal(reasons[3], "亮点：**经济** 超过 55% 的同位置玩家");
  assert.equal(fieldText(payload, "离上下一档"), "⬆️ 离上一名（下等马）差 **0.2** 分，惜败\n⬇️ 队内最后一名，后面没有退路了");
  assert.equal(fieldText(payload, "播报时的吐槽"), "> 参团率24%，队友在打团，你在峡谷里旅游采风。");
  assert.equal(fieldText(payload, "军师判词"), "离下等马只差 0.2 分，惜败，多插几个眼就上去了。");
  assert.equal(embed.footer?.text, "对局 NA1_5100000001 • 策马军师");
  const appeal = buttonOf(payload);
  assert.equal(appeal.label, "上诉");
  assert.equal(appeal.style, ButtonStyle.Danger);
  assert.equal(appeal.custom_id, "why-appeal:r:support-friend:NA1_5100000001");
});

test("/why explains a chosen match of another member and names them instead of saying 你", async () => {
  const strong = seededJungler().dimensions;
  seed([seededJungler({ dimensions: { ...strong, utility: 0.55 } }), seededJungler({ matchId: "NA1_LATER", playedAt: 1_900_000_000_000, tier: "没有马", teamRank: 5, scoreAbove: 4, scoreBelow: null, score: 1 })]);
  const payload = await verdictFor({ target: "jungle-friend", match: "NA1_5100000002" });
  assert.match(embedOf(payload).description!, /👑 \*\*特等马\*\* · \*\*9\.4\*\* 分/);
  assert.equal(fieldText(payload, "判决依据"), "每一项都不低于同位置中位数。\n亮点：**资源** 超过 97% 的同位置玩家");
  assert.equal(fieldText(payload, "离上下一档"), "⬆️ 队内第一，上面没有更高的档位了\n⬇️ 领先下一名（上等马）**0.2** 分，险胜");
  assert.ok(!fieldText(payload, "军师判词")!.includes("你"));
  assert.equal(fieldText(payload, "播报时"), undefined, "no commentary was stored for this record");
});

test("/why gives a private empty state when there is nothing to judge", async () => {
  setMemberAccounts(GUILD, "support-friend", [{ puuid: "p", gameName: "Friend", tagLine: "NA1" }]);
  const tracked = command();
  await whyCommand.execute(tracked.stub);
  assert.equal(tracked.calls.length, 1);
  assert.equal(tracked.calls[0].payload!.flags, MessageFlags.Ephemeral);
  assert.deepEqual(tracked.calls[0].payload!.allowedMentions, NO_MENTIONS);
  assert.match(embedOf(tracked.calls[0].payload!).description!, /<@support-friend> 还没有可以宣判的对局。\n每播报一局对局/);

  const stranger = command({ target: "stranger" });
  await whyCommand.execute(stranger.stub);
  assert.match(embedOf(stranger.calls[0].payload!).description!, /还没有被绑定，军师不替没登记的人判案/);

  const unknownMatch = command({ match: "NA1_404" });
  await whyCommand.execute(unknownMatch.stub);
  assert.match(embedOf(unknownMatch.calls[0].payload!).description!, /马厩里没有 NA1_404 这一局/);
});

test("/why keeps mock verdicts labeled and apart from real ones", async () => {
  seed([seededSupport({ mock: true })]);
  const real = command();
  await whyCommand.execute(real.stub);
  assert.match(embedOf(real.calls[0].payload!).description!, /还没有可以宣判的对局[\s\S]*另有 1 局模拟数据的记录，不计入真实档案/);

  process.env.RIOT_MODE = "mock";
  const payload = await verdictFor();
  const embed = embedOf(payload);
  assert.equal(embed.title, "模拟数据 · 判决书");
  assert.equal(embed.footer?.text, "模拟数据 / Mock data • 策马军师");
  assert.equal(buttonOf(payload).custom_id, "why-appeal:m:support-friend:NA1_5100000001");
});

test("/why refuses direct messages", async () => {
  const { stub, calls } = command({ guild: false });
  await whyCommand.execute(stub);
  assert.equal(calls[0].payload!.flags, MessageFlags.Ephemeral);
  assert.match(embedOf(calls[0].payload!).description!, /只能在服务器里使用/);
});

test("the match option suggests the member's recent games of the current kind, newest first", async () => {
  seed([
    seededSupport({ matchId: "NA1_1", playedAt: Date.UTC(2026, 9, 26, 4, 5) }),
    seededSupport({ matchId: "NA1_2", playedAt: Date.UTC(2026, 9, 27, 4, 5), tier: "上等马", score: 7.25, won: true }),
    seededSupport({ matchId: "NA1_3", playedAt: Date.UTC(2026, 9, 27, 5, 0), mock: true }),
    seededJungler({ matchId: "NA1_9" }),
  ]);
  const mine = autocomplete();
  await whyCommand.autocomplete!(mine.stub);
  assert.deepEqual(mine.responses[0], [
    { name: "上等马 · 锤石 · 7.3 分 · 胜 · 10/26 21:05", value: "NA1_2" },
    { name: "没有马 · 锤石 · 1.6 分 · 负 · 10/25 21:05", value: "NA1_1" },
  ]);

  const filtered = autocomplete({ typed: "上等" });
  await whyCommand.autocomplete!(filtered.stub);
  assert.deepEqual(filtered.responses[0].map((choice) => choice.value), ["NA1_2"]);

  const theirs = autocomplete({ target: "jungle-friend" });
  await whyCommand.autocomplete!(theirs.stub);
  assert.deepEqual(theirs.responses[0].map((choice) => choice.value), ["NA1_9"]);

  const other = autocomplete({ focused: "user" });
  await whyCommand.autocomplete!(other.stub);
  assert.deepEqual(other.responses[0], []);

  assert.match(choiceName(seededSupport({ mock: true })), /^模拟 · 没有马/);
});

test("only the member can appeal; anyone else gets a private, playful refusal", async () => {
  seed([seededSupport()]);
  const { stub, calls } = button("why-appeal:r:support-friend:NA1_5100000001", "bystander");
  await whyCommand.handleButton!(stub);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "reply");
  assert.equal(calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(calls[0].payload.allowedMentions, NO_MENTIONS);
  assert.match(calls[0].payload.content!, /当事人 <@support-friend>/);
});

test("an appeal is upheld in public, closes the case and never changes the record", async () => {
  seed([seededSupport()]);
  const before = listHorseRecords(GUILD, { mock: false });
  const first = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(first.stub);
  assert.deepEqual(first.calls.map((call) => call.kind), ["update", "followUp"]);
  const closed = buttonOf(first.calls[0].payload);
  assert.equal(closed.disabled, true);
  assert.equal(closed.label, "本案已结 · 维持原判");
  const ruling = first.calls[1].payload;
  assert.equal(ruling.flags, undefined, "the ruling is public");
  assert.deepEqual(ruling.allowedMentions, NO_MENTIONS);
  assert.equal(embedOf(ruling).title, "上诉裁定 · 维持原判");
  const text = embedOf(ruling).description!;
  assert.match(text, /呈堂证供：视野只超过 9% 的同位置玩家/);
  assert.match(text, /惜败.*驳回上诉，维持原判：没有马。/);

  const again = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(again.stub);
  assert.deepEqual(again.calls.map((call) => call.kind), ["reply"]);
  assert.equal(again.calls[0].payload.content, "本案已结，维持原判。");
  assert.equal(again.calls[0].payload.flags, MessageFlags.Ephemeral);

  // A new /why of the same match shows the case as closed.
  const payload = await verdictFor();
  assert.equal(buttonOf(payload).disabled, true);
  assert.deepEqual(listHorseRecords(GUILD, { mock: false }), before);

  // The case is closed in the database, not in memory: it stays closed after the connection is reopened.
  closeDatabase();
  const afterRestart = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(afterRestart.stub);
  assert.deepEqual(afterRestart.calls.map((call) => call.kind), ["reply"]);
  assert.equal(afterRestart.calls[0].payload.content, "本案已结，维持原判。");
  assert.equal(buttonOf(await verdictFor()).disabled, true);

  // The ruling is deterministic: once reopened, the case is heard the same way.
  assert.equal(reopenAppeal({ guildId: GUILD, discordUserId: "support-friend", matchId: "NA1_5100000001", mock: false }), true);
  const replay = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(replay.stub);
  assert.equal(embedOf(replay.calls[1].payload).description, text);
});

test("mock and real cases of the same match are separate", async () => {
  seed([seededSupport(), seededSupport({ mock: true })]);
  const mock = button("why-appeal:m:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(mock.stub);
  assert.deepEqual(mock.calls.map((call) => call.kind), ["update", "followUp"]);
  const real = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(real.stub);
  assert.deepEqual(real.calls.map((call) => call.kind), ["update", "followUp"], "the mock case did not close the real one");
});

test("a mock appeal is labeled and reads only mock records", async () => {
  seed([seededSupport({ mock: true })]);
  const real = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(real.stub);
  assert.match(real.calls[0].payload.content!, /档案已经不在马厩里了/);

  const mock = button("why-appeal:m:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(mock.stub);
  assert.equal(embedOf(mock.calls[1].payload).title, "模拟数据 · 上诉裁定 · 维持原判");
  assert.equal(embedOf(mock.calls[1].payload).footer?.text, "模拟数据 / Mock data • 策马军师");
});

test("appeal custom IDs round-trip and refuse anything that does not fit", () => {
  const record = makeHorseRecord({ discordUserId: "123456789012345678", matchId: "NA1_5123456789" });
  const id = appealCustomId(record)!;
  assert.ok(id.length <= 100);
  assert.deepEqual(parseAppealCustomId(id), { mock: false, memberId: "123456789012345678", matchId: "NA1_5123456789" });
  assert.equal(parseAppealCustomId("why-appeal:x:1:NA1_1"), null);
  assert.equal(parseAppealCustomId("other:r:1:NA1_1"), null);
  assert.equal(appealCustomId({ ...record, matchId: "NA1:with:colons" }), null);
});

test("/why describes its options in Chinese with match autocomplete", () => {
  const json = whyCommand.data.toJSON();
  assert.equal(json.name, "why");
  const options = json.options as Array<{ name: string; autocomplete?: boolean; required?: boolean }>;
  assert.deepEqual(options.map((option) => option.name), ["user", "match"]);
  assert.equal(options[1].autocomplete, true);
  assert.ok(options.every((option) => !option.required));
});

test("a failed radar still sends the verdict without its image and logs only the error class", async () => {
  seed([seededSupport()]);
  whyDependencies.renderRadar = async () => { throw Object.assign(new Error("private detail NA1_5100000001"), { name: "RenderError" }); };
  const payload = await verdictFor();
  const embed = embedOf(payload);
  assert.equal(embed.image, undefined);
  assert.deepEqual(payload.files, []);
  assert.equal(embed.title, "判决书 · 策马军师");
  assert.match(fieldText(payload, "拖后腿的维度")!, /^\*\*视野\*\*/);
  assert.equal(buttonOf(payload).label, "上诉");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /The \/why radar could not be rendered: RenderError$/);
  assert.doesNotMatch(errors.join("\n"), /private detail/);
});

test("an ADC whose only red axis does not count is told only the counted items are above the median", async () => {
  seed([makeHorseRecord({
    guildId: GUILD, discordUserId: "support-friend", puuid: "puuid-adc", matchId: "NA1_ADC", position: "BOTTOM",
    tier: "下等马", teamRank: 4, score: 5.2, scoreAbove: 6.5, scoreBelow: 4,
    dimensions: { damage: 0.6, teamfight: 0.6, survival: 0.6, economy: 0.6, frontline: 0.1, vision: 0.6, objectives: 0.6, utility: 0.6, matchup: 0.6 },
  })]);
  const payload = await verdictFor();
  assert.match(fieldText(payload, "判决依据")!, /^计入评分的每一项都不低于同位置中位数。/);
  assert.match(fieldText(payload, "军师判词")!, /^计入评分的每一项都在同位置中位数以上/);
});

test("in a team larger than five the gap names a same-tier neighbour by place", async () => {
  seed([seededSupport({ tier: "上等马", teamRank: 3, teamSize: 7, score: 6, scoreAbove: 6.2, scoreBelow: 5.9 })]);
  const payload = await verdictFor();
  assert.equal(fieldText(payload, "离上下一档"), "⬆️ 离上一名差 **0.2** 分，惜败\n⬇️ 领先下一名（中等马）**0.1** 分，险胜");
});

test("a case is reopened when the ruling could not be sent", async () => {
  seed([seededSupport()]);
  const failed = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend", { failUpdate: true });
  await assert.rejects(whyCommand.handleButton!(failed.stub), /Unknown interaction/);
  assert.equal(failed.calls.length, 0);

  const retry = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  await whyCommand.handleButton!(retry.stub);
  assert.deepEqual(retry.calls.map((call) => call.kind), ["update", "followUp"], "the member can appeal again");
});

test("a case is reopened when the ruling follow-up fails after the button was disabled", async () => {
  seed([seededSupport()]);
  const stub = button("why-appeal:r:support-friend:NA1_5100000001", "support-friend");
  (stub.stub as unknown as { followUp: () => Promise<void> }).followUp = async () => { throw new Error("Missing Permissions"); };
  await assert.rejects(whyCommand.handleButton!(stub.stub), /Missing Permissions/);
  assert.equal(isAppealClosed({ guildId: GUILD, discordUserId: "support-friend", matchId: "NA1_5100000001", mock: false }), false);
});

test("an appeal after /stable-erase finds no case and closes nothing", async () => {
  seed([seededSupport()]);
  const payload = await verdictFor();
  assert.equal(buttonOf(payload).disabled, false);
  assert.equal(eraseMemberHorseRecords(GUILD, "support-friend"), 1);
  const late = button(buttonOf(payload).custom_id, "support-friend");
  await whyCommand.handleButton!(late.stub);
  assert.deepEqual(late.calls.map((call) => call.kind), ["reply"]);
  assert.equal(late.calls[0].payload.content, "这一局的档案已经不在马厩里了，无案可审。");
  assert.equal(late.calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(listHorseRecords(GUILD, { mock: false }), []);
  assert.equal(isAppealClosed({ guildId: GUILD, discordUserId: "support-friend", matchId: "NA1_5100000001", mock: false }), false, "nothing was closed");
});
