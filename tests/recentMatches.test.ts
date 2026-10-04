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
  return { riotId: "Tracked#NA1", puuid: "tracked", lastMatchId: "NA1_4", matches };
}

function view(overrides: Partial<RecentMatchesView> = {}): RecentMatchesView {
  return {
    mock: false, memberId: "member-1", voiceChannelId: "voice-1", pollIntervalSeconds: 45,
    status: { active: true, startedAt: ENDED, lastPollAt: ENDED + 30_000, announced: new Set() },
    accounts: [account()], ...overrides,
  };
}

const rows = (embed: ReturnType<typeof buildRecentMatchesEmbed>) => embed.toJSON().fields![0].value.split("\n");

test("each match shows the result, champion, queue, end time and what the monitor will do with it", () => {
  const embed = buildRecentMatchesEmbed(view());
  const json = embed.toJSON();
  assert.equal(json.title, "最近对局 · 策马军师");
  assert.equal(json.fields![0].name, "Tracked#NA1");
  assert.match(json.description!, /^🟢 正在监听 <@member-1> · <#voice-1> · 每 45 秒检查一次 · 上次检查 <t:1759500030:R>/);
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
    status: { active: true, startedAt: ENDED, lastPollAt: ENDED, announced: new Set(["NA1_4"]) },
  }));
  assert.match(rows(embed)[1], /📢 已播报$/);
});

test("without monitoring the reply explains why and shows the last error", () => {
  const absent = buildRecentMatchesEmbed(view({ voiceChannelId: null,
    status: { active: false, announced: new Set() }, accounts: [{ ...account(), lastMatchId: undefined }] }));
  assert.match(absent.toJSON().description!, /^⚪ 没在监听：<@member-1> 不在语音频道。进入语音频道后才开始监听，之前结束的对局不会补播。$/);
  assert.ok(rows(absent).every((row) => !/监听起点|下次检查/.test(row)));
  const stopped = buildRecentMatchesEmbed(view({
    status: { active: false, lastError: { message: "Riot API key is invalid.", at: ENDED }, announced: new Set() },
  }));
  assert.match(stopped.toJSON().description!, /监听已停止/);
  assert.match(stopped.toJSON().description!, /⚠️ 上次错误 <t:1759500000:R>：Riot API key is invalid\./);
});

test("notices replace the match list, mock data is labeled and long lists fit Discord limits", () => {
  const embed = buildRecentMatchesEmbed(view({ mock: true, accounts: [
    { riotId: "MockWin#NA1", puuid: "MOCK-1", matches: [], notice: "⚠️ 这是模拟账号" },
    { riotId: "Empty#NA1", puuid: "empty", matches: [] },
    { ...account(), matches: Array.from({ length: 30 }, () => account().matches[0]) },
  ] })).toJSON();
  assert.equal(embed.title, "模拟数据 · 最近对局");
  assert.match(embed.footer!.text, /模拟数据/);
  assert.equal(embed.fields![0].value, "⚠️ 这是模拟账号");
  assert.equal(embed.fields![1].value, "没有对局记录。");
  assert.ok(embed.fields![2].value.length <= 1024);
});
