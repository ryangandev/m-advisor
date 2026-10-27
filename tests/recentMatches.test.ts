import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecentMatchesEmbed, type RecentAccountView, type RecentMatchesView } from "../src/utils/embeds";
import { testMatch } from "./helpers/matches";

const ENDED = 1_759_500_000_000;

function account(): RecentAccountView {
  const matches = ["NA1_5", "NA1_4", "NA1_3", "NA1_2", "NA1_1"].map((matchId, index) => {
    const detail = testMatch(matchId, ["tracked"], index === 0 ? "win" : "loss");
    detail.info.gameEndTimestamp = ENDED - index * 3_600_000;
    return { matchId, detail };
  });
  matches[3].detail.info.queueId = 450;
  matches[4].detail.info.aborted = true;
  return { memberOrder: 1, riotId: "Tracked#NA1", puuid: "tracked", lastMatchId: "NA1_4", matches };
}

function view(overrides: Partial<RecentMatchesView> = {}): RecentMatchesView {
  return {
    mock: false, members: [{ memberId: "member-1", order: 1, voiceChannelId: "voice-1", monitored: true }], pollIntervalSeconds: 45,
    status: { active: true, startedAt: ENDED, lastPollAt: ENDED + 30_000, announced: new Set(), presentMemberIds: ["member-1"] },
    accounts: [account()], ...overrides,
  };
}

const rows = (embed: ReturnType<typeof buildRecentMatchesEmbed>) => embed.toJSON().fields![0].value.split("\n");

test("each match shows the result, champion, queue, end time and what the monitor will do with it", () => {
  const embed = buildRecentMatchesEmbed(view());
  const json = embed.toJSON();
  assert.equal(json.title, "最近对局 · 策马军师");
  assert.equal(json.fields![0].name, "1. Tracked#NA1");
  assert.match(json.description!, /^🟢 正在监听 · 每 45 秒检查一次 · 上次检查 <t:1759500030:R>\n1\. <@member-1> · <#voice-1> · 监听中\n/);
  assert.match(json.description!, /监听起点之后结束的召唤师峡谷对局会被播报/);
  const [newest, baseline, older, aram, aborted] = rows(embed);
  assert.equal(newest, "✅ 胜 · 阿狸 8/2/7 · 单双排 · 30 分钟 · <t:1759500000:R> · ⏳ 下次检查时播报");
  assert.match(baseline, /^❌ 负 · 阿狸 2\/7\/4 · 单双排 · .* · 📍 监听起点$/);
  assert.doesNotMatch(older, /监听起点|播报/);
  assert.match(aram, /大乱斗 .*不播报此模式$/);
  assert.match(aborted, /^⏹️ 中止/);
});

test("an announced match is marked as announced instead of the baseline", () => {
  const embed = buildRecentMatchesEmbed(view({
    status: { active: true, startedAt: ENDED, lastPollAt: ENDED, announced: new Set(["NA1_4"]), presentMemberIds: ["member-1"] },
  }));
  assert.match(rows(embed)[1], /📢 已播报$/);
});

test("without monitoring the reply explains why and shows the last error", () => {
  const absent = buildRecentMatchesEmbed(view({ members: [{ memberId: "member-1", order: 1, voiceChannelId: null, monitored: false }],
    status: { active: false, announced: new Set(), presentMemberIds: [] }, accounts: [{ ...account(), lastMatchId: undefined }] }));
  assert.equal(absent.toJSON().description!, "⚪ 没在监听：没有被追踪成员在语音频道。进入语音频道后才开始监听，之前结束的对局不会补播。\n1. <@member-1> · 不在语音 · 未监听");
  assert.ok(rows(absent).every((row) => !/监听起点|下次检查/.test(row)));
  const stopped = buildRecentMatchesEmbed(view({
    status: { active: false, lastError: { message: "Riot API key is invalid.", at: ENDED }, announced: new Set(), presentMemberIds: [] },
  }));
  assert.match(stopped.toJSON().description!, /监听已停止/);
  assert.match(stopped.toJSON().description!, /⚠️ 上次错误 <t:1759500000:R>：Riot API key is invalid\./);
});

test("notices replace the match list, mock data is labeled and long lists fit Discord limits", () => {
  const embed = buildRecentMatchesEmbed(view({ mock: true, accounts: [
    { memberOrder: 1, riotId: "MockWin#NA1", puuid: "MOCK-1", matches: [], notice: "⚠️ 这是模拟账号" },
    { memberOrder: 1, riotId: "Empty#NA1", puuid: "empty", matches: [] },
    { ...account(), matches: Array.from({ length: 30 }, () => account().matches[0]) },
  ] })).toJSON();
  assert.equal(embed.title, "模拟数据 · 最近对局");
  assert.match(embed.footer!.text, /模拟数据/);
  assert.equal(embed.fields![0].value, "⚠️ 这是模拟账号");
  assert.equal(embed.fields![1].value, "没有对局记录。");
  assert.ok(embed.fields![2].value.length <= 1024);
});

test("several members each get a status line and their accounts are numbered by bind order", () => {
  const embed = buildRecentMatchesEmbed(view({
    members: [
      { memberId: "member-1", order: 1, voiceChannelId: "voice-1", monitored: true },
      { memberId: "member-2", order: 2, voiceChannelId: null, monitored: false },
      { memberId: "member-3", order: 3, voiceChannelId: "voice-2", monitored: true },
    ],
    accounts: [
      account(),
      { ...account(), memberOrder: 2, riotId: "Second#NA1" },
      { ...account(), memberOrder: 3, riotId: "Third#NA1" },
    ],
  })).toJSON();
  assert.deepEqual(embed.description!.split("\n").slice(1, 4), [
    "1. <@member-1> · <#voice-1> · 监听中",
    "2. <@member-2> · 不在语音 · 未监听",
    "3. <@member-3> · <#voice-2> · 监听中",
  ]);
  assert.deepEqual(embed.fields!.map((field) => field.name), ["1. Tracked#NA1", "2. Second#NA1", "3. Third#NA1"]);
});

test("a stopped session with a member in voice says monitoring stopped", () => {
  const embed = buildRecentMatchesEmbed(view({
    members: [
      { memberId: "member-1", order: 1, voiceChannelId: null, monitored: false },
      { memberId: "member-2", order: 2, voiceChannelId: "voice-1", monitored: false },
    ],
    status: { active: false, announced: new Set(), presentMemberIds: [] },
  })).toJSON();
  assert.match(embed.description!, /^⚪ 没在监听：有成员在语音频道里，但监听已停止。/);
});

function embedLength(embed: ReturnType<ReturnType<typeof buildRecentMatchesEmbed>["toJSON"]>): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

test("ten members with ten matches each stay within Discord's 6000-character embed total", () => {
  const members = Array.from({ length: 10 }, (_, index) => ({
    memberId: `10000000000000000${index}`, order: index + 1, voiceChannelId: `20000000000000000${index}`, monitored: true,
  }));
  const tenMatches = Array.from({ length: 10 }, (_, index) => ({ ...account().matches[index % 3], matchId: `NA1_${100 - index}` }));
  const accounts = members.map((member) => ({ ...account(), memberOrder: member.order, riotId: `LongerRiotName${member.order}#NA1`, matches: tenMatches }));
  const embed = buildRecentMatchesEmbed(view({ members, accounts, status: {
    active: true, startedAt: ENDED, lastPollAt: ENDED, announced: new Set(), presentMemberIds: members.map((member) => member.memberId),
    lastError: { message: "x".repeat(400), at: ENDED },
  } })).toJSON();
  assert.ok(embedLength(embed) <= 6000, `embed total is ${embedLength(embed)}`);
  assert.equal(embed.fields!.length, 10);
  for (const field of embed.fields!) {
    const shown = field.value.split("\n");
    assert.match(shown[0], /^✅ 胜 · 阿狸/, "the newest row is always kept");
    assert.equal(shown.at(-1), "…", "dropped rows are marked");
    assert.ok(shown.length < 11);
  }
});

test("a newest row longer than its share is shortened rather than dropped", () => {
  const notice = `⚠️ ${"很长的提示".repeat(60)}`;
  const accounts = Array.from({ length: 25 }, (_, index) => ({ ...account(), riotId: `Player${index}#NA1`, notice }));
  const embed = buildRecentMatchesEmbed(view({ accounts })).toJSON();
  assert.ok(embedLength(embed) <= 6000, `embed total is ${embedLength(embed)}`);
  for (const field of embed.fields!) {
    assert.ok(field.value.startsWith("⚠️ 很长的提示"), field.value);
    assert.ok(field.value.endsWith("\n…"));
  }
});

test("a short list keeps every row without a marker", () => {
  const embed = buildRecentMatchesEmbed(view()).toJSON();
  assert.equal(embed.fields![0].value.split("\n").length, 5);
  assert.doesNotMatch(embed.fields![0].value, /…/);
});

test("the 25-field cap counts accounts across every member", () => {
  const accounts = Array.from({ length: 30 }, (_, index) => ({ ...account(), memberOrder: Math.floor(index / 3) + 1, riotId: `Player${index}#NA1` }));
  const embed = buildRecentMatchesEmbed(view({ accounts })).toJSON();
  assert.equal(embed.fields!.length, 25);
  assert.equal(embed.fields!.at(-1)!.name, "9. Player24#NA1");
});
