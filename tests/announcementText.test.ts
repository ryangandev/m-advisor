import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatchAnnouncement, championLabel } from "../src/services/announcementText";
import { buildHorseReportEmbed } from "../src/utils/embeds";
import { testMatch } from "./helpers/matches";

const TIER_ORDER = /特等马，.*上等马，.*中等马，.*下等马，.*没有马，/;

test("speech ranks all five teammates, praises 特等马 and roasts 没有马", () => {
  const { speech, report } = buildMatchAnnouncement(testMatch("SPEECH-WIN", ["tracked"], "win"), "tracked", true);
  assert.match(speech, /^模拟战报。Tracked这局赢了，打了30分钟。/);
  assert.match(speech, TIER_ORDER);
  assert.doesNotMatch(speech, /Enemy/);
  assert.equal(report.lines.length, 5);
  const best = report.lines[0];
  const worst = report.lines[4];
  assert.match(speech, new RegExp(`特等马，${best.champion}，${best.name}，${best.score.toFixed(1)}分。`));
  assert.ok(report.praise!.includes(best.name));
  assert.ok(report.roast!.includes(worst.name));
  assert.ok(speech.endsWith(report.roast!));
  assert.ok(speech.length < 1000, "fits the local speech request limit");
});

test("real mode carries no simulated label and the result follows the tracked team", () => {
  const { speech, report } = buildMatchAnnouncement(testMatch("SPEECH-LOSS", ["tracked"], "loss"), "tracked", false);
  assert.match(speech, /^Tracked这局输了/);
  assert.doesNotMatch(speech, /模拟/);
  assert.doesNotMatch(report.title, /模拟/);
  assert.match(report.praise!, /虽然输了/);
});

test("the same match always produces the same report", () => {
  const first = buildMatchAnnouncement(testMatch("STABLE", ["tracked"]), "tracked", true);
  const second = buildMatchAnnouncement(testMatch("STABLE", ["tracked"]), "tracked", true);
  assert.deepEqual(first, second);
});

test("remakes and very short games are not judged", () => {
  const remake = testMatch("REMAKE", ["tracked"]);
  remake.info.earlySurrender = true;
  const short = testMatch("SHORT", ["tracked"]);
  short.info.gameDuration = 7 * 60;
  for (const detail of [remake, short]) {
    const { speech, report } = buildMatchAnnouncement(detail, "tracked", false);
    assert.match(speech, /不予鉴定/);
    assert.doesNotMatch(speech, /特等马|没有马/);
    assert.deepEqual(report.lines, []);
    assert.equal(report.praise, undefined);
  }
});

test("aborted games without a winner are not judged", () => {
  const detail = testMatch("ABORTED", ["tracked"]);
  detail.info.aborted = true;
  const { speech, report } = buildMatchAnnouncement(detail, "tracked", false);
  assert.match(speech, /被系统中止.*不予鉴定/);
  assert.doesNotMatch(speech, /输了|赢了|特等马|没有马/);
  assert.deepEqual(report.lines, []);
  const embed = buildHorseReportEmbed(report).toJSON();
  assert.ok(!embed.fields?.some((field) => field.name === "马匹排行"));
});

test("names cannot inject mentions or markdown and long names stay within limits", () => {
  const detail = testMatch("NAMES", ["tracked"]);
  for (const player of detail.info.participants) player.riotIdGameName = "@everyone <@123> **bold** `code` ".repeat(4);
  const { speech, report } = buildMatchAnnouncement(detail, "tracked", true);
  const embed = JSON.stringify(buildHorseReportEmbed(report).toJSON());
  for (const text of [speech, embed]) assert.doesNotMatch(text, /@everyone|<@|\*\*bold|`code/);
  assert.ok(report.lines.every((line) => line.name.length <= 32));
  assert.ok(speech.length < 1000);
});

test("the summoner is called out when they are 特等马 or 没有马", () => {
  const detail = testMatch("SELF", ["tracked"], "win");
  const ranking = buildMatchAnnouncement(detail, "tracked", true).report.lines;
  const trackedLine = ranking.find((line) => line.tracked)!;
  // Make the tracked player feed badly, so they become 没有马.
  const tracked = detail.info.participants[0];
  tracked.kills = 0; tracked.deaths = 15; tracked.assists = 1;
  tracked.stats = { ...tracked.stats, totalDamageDealtToChampions: 1000, goldEarned: 5000, champExperience: 6000, totalMinionsKilled: 60 };
  const { speech, report } = buildMatchAnnouncement(detail, "tracked", true);
  assert.equal(report.lines.at(-1)!.tracked, true, `tracked was ${trackedLine.tier} before feeding`);
  assert.match(speech, /这匹没有马，正是召唤军师的本人/);
});

test("a matchup verdict never cites a zero or contradicting gold difference", () => {
  const detail = testMatch("MATCHUP", ["tracked"], "win");
  const allies = detail.info.participants.filter((player) => player.teamId === 100);
  // Make every ally equal to their opponent in gold, so matchup cannot justify a gold-based line.
  for (const ally of allies) {
    const opponent = detail.info.participants.find((player) => player.teamId === 200 && player.position === ally.position)!;
    opponent.stats.goldEarned = ally.stats.goldEarned;
  }
  const { speech } = buildMatchAnnouncement(detail, "tracked", true);
  assert.doesNotMatch(speech, /多赚了0经济|多拿了0经济|-\d+经济/);
});

test("quoted statistics always sound like the verdict they support", () => {
  // Each pattern captures the quoted number and states the bar it must clear.
  const checks: Array<[RegExp, (value: number) => boolean]> = [
    [/全队百分之(\d+)的伤害，这不是马/, (value) => value >= 25],
    [/参团率百分之(\d+)，哪里有架/, (value) => value >= 60],
    [/每分钟进账(\d+)金币/, (value) => value >= 450],
    [/扛下百分之(\d+)的伤害/, (value) => value >= 25],
    [/治疗加护盾(\d+)点/, (value) => value >= 3000],
    [/控了对面(\d+)秒/, (value) => value >= 30],
    [/比对位多赚了(\d+)经济/, (value) => value >= 500],
    [/伤害只占全队百分之(\d+)/, (value) => value <= 15],
    [/参团率百分之(\d+)，队友在打团/, (value) => value <= 40],
    [/死了(\d+)次/, (value) => value >= 7],
    [/每分钟补刀([\d.]+)个/, (value) => value <= 6],
    [/承伤只有全队百分之(\d+)/, (value) => value <= 18],
    [/被对位多拿了(\d+)经济/, (value) => value >= 500],
  ];
  let seed = 1;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const quoted = new Set<number>();
  for (let index = 0; index < 300; index++) {
    const detail = testMatch(`QUOTE-${index}`, ["tracked"], index % 2 ? "win" : "loss");
    // Reshape every player's statistics independently so each dimension can be the best or the worst.
    for (const player of detail.info.participants) {
      for (const key of Object.keys(player.stats) as Array<keyof typeof player.stats>) player.stats[key] = player.stats[key]! * (0.1 + random() * 2.4);
      player.kills = Math.floor(random() * 12);
      player.deaths = Math.floor(random() * 14);
      player.assists = Math.floor(random() * 20);
    }
    const { speech } = buildMatchAnnouncement(detail, "tracked", false);
    checks.forEach(([pattern, valid], check) => {
      const match = speech.match(pattern);
      if (!match) return;
      quoted.add(check);
      assert.ok(valid(Number(match[1])), `${match[0]} in ${speech}`);
    });
  }
  assert.ok(quoted.size >= 10, `only ${quoted.size} kinds of statistics were quoted`);
});

test("Chinese champion names come from Data Dragon with a safe fallback", () => {
  const detail = testMatch("CHAMPIONS", ["tracked"]);
  assert.equal(championLabel(detail.info.participants[0]), "阿狸");
  assert.equal(championLabel({ ...detail.info.participants[0], championId: 99999, championName: "Newbie<@1>" }), "Newbie 1");
});

test("the channel report lists every tier with its score", () => {
  const { report } = buildMatchAnnouncement(testMatch("EMBED", ["tracked"], "win"), "tracked", true);
  const embed = buildHorseReportEmbed(report).toJSON();
  assert.match(embed.title!, /^模拟战报 · 策马军师/);
  assert.match(embed.footer!.text, /模拟数据/);
  const ranking = embed.fields!.find((field) => field.name === "马匹排行")!.value;
  for (const line of report.lines) assert.ok(ranking.includes(`**${line.tier}** ${line.champion}`));
  assert.ok(ranking.includes("(召唤者)"));
  assert.ok(embed.fields!.some((field) => field.name.includes("表扬")));
  assert.ok(embed.fields!.some((field) => field.name.includes("批评")));
});
