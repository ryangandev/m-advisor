import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DIMENSIONS, HORSE_TIERS, tierForRank } from "../src/services/horseRanking";
import {
  CLOSE_GAP, appealRuling, buildVerdict, dimensionEvidence, findVerdictRecord, formatGap, listVerdictChoices, verdictSummary,
} from "../src/services/horseVerdict";
import { closeDatabase } from "../src/store/database";
import { makeHorseRecord, recordTracked } from "./helpers/horseRecords";
import { seededJungler, seededSupport } from "./helpers/verdicts";

let directory: string;
let savedPath: string | undefined;

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "m-advisor-verdict-"));
  savedPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(directory, "bot.sqlite3");
});

afterEach(() => {
  closeDatabase();
  if (savedPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = savedPath;
  rmSync(directory, { recursive: true, force: true });
});

test("tierForRank maps a team of five one-to-one and spreads other sizes over the five tiers", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((rank) => tierForRank(rank, 5)), [...HORSE_TIERS]);
  assert.equal(tierForRank(1, 1), "特等马");
  assert.deepEqual([1, 2, 3].map((rank) => tierForRank(rank, 3)), ["特等马", "中等马", "没有马"]);
});

test("the verdict names the dimensions that cost the most by position weight times shortfall", () => {
  const verdict = buildVerdict(seededSupport());
  assert.equal(verdict.positionLabel, "辅助");
  // UTILITY weights: vision 0.22 x 0.41, teamfight 0.20 x 0.32, utility 0.22 x 0.28.
  assert.deepEqual(verdict.drags.map((entry) => entry.dimension), ["vision", "teamfight", "utility"]);
  assert.ok(Math.abs(verdict.drags[0].impact - -0.0902) < 1e-9);
  assert.equal(verdict.drags[0].weight, 0.22);
  assert.ok(Math.abs(verdict.drags[0].share - 0.22) < 1e-9, "all nine dimensions are present, so the share is the weight");
  assert.equal(verdict.best?.dimension, "economy");
  assert.deepEqual(verdict.dimensions.map((entry) => entry.dimension), [...DIMENSIONS]);
  assert.deepEqual(verdict.dimensions.filter((entry) => entry.key).map((entry) => entry.dimension), ["teamfight", "vision", "utility"]);
});

test("a dimension the position barely weighs costs little even far below the median", () => {
  // Vision is slightly below the median for a bottom laner (weight 0.04); damage is far below (weight 0.26).
  const verdict = buildVerdict(makeHorseRecord({
    position: "BOTTOM",
    dimensions: { damage: 0.3, vision: 0.05, frontline: 0, economy: 0.6 },
  }));
  assert.deepEqual(verdict.drags.map((entry) => entry.dimension), ["damage", "vision"]);
  // Frontline has no weight for a bottom laner, so it cannot cost anything.
  assert.ok(!verdict.drags.some((entry) => entry.dimension === "frontline"));
});

test("missing dimensions are skipped and an unknown position uses the all-position weights", () => {
  const verdict = buildVerdict(makeHorseRecord({ position: null, dimensions: { damage: 0.2, teamfight: 0.4 } }));
  assert.equal(verdict.positionLabel, "未知位置");
  assert.deepEqual(verdict.drags.map((entry) => entry.dimension), ["damage", "teamfight"]);
  assert.equal(verdict.dimensions.find((entry) => entry.dimension === "vision")?.percentile, undefined);
  assert.equal(verdict.best, null);
});

test("neighbouring tiers carry their gap and are close at or below the threshold", () => {
  const support = buildVerdict(seededSupport());
  assert.deepEqual({ tier: support.above?.tier, close: support.above?.close }, { tier: "下等马", close: true });
  assert.ok(Math.abs(support.above!.gap - 0.2) < 1e-9);
  assert.equal(support.below, null);

  const jungler = buildVerdict(seededJungler());
  assert.equal(jungler.above, null);
  assert.deepEqual({ tier: jungler.below?.tier, close: jungler.below?.close }, { tier: "上等马", close: true });

  const atThreshold = buildVerdict(makeHorseRecord({ score: 5, scoreAbove: 5 + CLOSE_GAP, scoreBelow: 5 - CLOSE_GAP - 0.06 }));
  assert.equal(atThreshold.above?.close, true, "0.3 points is still 惜败");
  assert.equal(atThreshold.below?.close, false, "0.36 points prints as 0.4 and is no longer 险胜");
  assert.equal(atThreshold.above?.tier, "上等马");
  assert.equal(atThreshold.below?.tier, "下等马");
});

test("gaps print with the announcement's rounding and never as zero", () => {
  assert.equal(formatGap(0.25), "0.3");
  assert.equal(formatGap(1.04), "1.0");
  assert.equal(formatGap(0.02), "不到 0.1");
});

test("evidence quotes the record's own statistics for a dimension", () => {
  const record = seededSupport();
  assert.deepEqual(dimensionEvidence("vision", record), ["每分钟视野得分 0.8", "插了 3 个真眼"]);
  assert.deepEqual(dimensionEvidence("teamfight", record), ["参团率 24%", "0/9/4"]);
  assert.deepEqual(dimensionEvidence("matchup", makeHorseRecord({ durationSeconds: 1200, features: { goldDiffPerMinute: -40 } })), ["比对位少 800 经济"]);
  assert.deepEqual(dimensionEvidence("frontline", makeHorseRecord({ features: {} })), []);
});

test("objectives evidence leads with building damage and counts barons with dragons and heralds", () => {
  const record = makeHorseRecord({ features: { buildingDamagePerMinute: 95.4, epicObjectiveShare: 0.25, turretShare: 0.1 } });
  assert.deepEqual(dimensionEvidence("objectives", record), ["每分钟 95 建筑伤害", "龙、先锋和大龙参与 25%"]);
});

test("evidence never quotes a lead in the member's favour as if it were proof against them", () => {
  const ahead = makeHorseRecord({ durationSeconds: 1200, features: { goldDiffPerMinute: 30, maxCsAdvantage: 12 } });
  assert.deepEqual(dimensionEvidence("matchup", ahead), []);
  const behind = makeHorseRecord({ durationSeconds: 1200, features: { goldDiffPerMinute: -40, maxCsAdvantage: -3 } });
  assert.deepEqual(dimensionEvidence("matchup", behind), ["比对位少 800 经济", "补刀从没领先过对位"]);
  assert.deepEqual(dimensionEvidence("matchup", makeHorseRecord({ features: { maxCsAdvantage: 0 } })), ["补刀从没领先过对位"]);
});

test("a share of the score divides by the weights of the dimensions that had data", () => {
  // Without data for six dimensions, a support's vision (0.22) is 0.22 / (0.22 + 0.20 + 0.22) of the score.
  const verdict = buildVerdict(seededSupport({ dimensions: { vision: 0.1, teamfight: 0.4, utility: 0.6 } }));
  assert.equal(verdict.drags[0].dimension, "vision");
  assert.ok(Math.abs(verdict.drags[0].share - 0.22 / 0.64) < 1e-9);
  assert.match(appealRuling(verdict), /在这局辅助评分里占 34%/);
});

test("惜败 and 险胜 follow the printed gap, so the same printed number always gets the same label", () => {
  const prints03 = buildVerdict(makeHorseRecord({ score: 5, scoreAbove: 5.34, scoreBelow: 4.66 }));
  assert.equal(formatGap(prints03.above!.gap), "0.3");
  assert.equal(prints03.above?.close, true);
  assert.equal(prints03.below?.close, true);
  const prints04 = buildVerdict(makeHorseRecord({ score: 5, scoreAbove: 5.36, scoreBelow: 4.64 }));
  assert.equal(formatGap(prints04.above!.gap), "0.4");
  assert.equal(prints04.above?.close, false);
  assert.equal(prints04.below?.close, false);
});

test("a 没有马 whose worst dimension is not a key one is never told it is what the position values most", () => {
  // Survival at 0 (weight 0.08) costs more than vision at 0.45 (weight 0.22) for a support.
  const dimensions = { damage: 0.6, teamfight: 0.6, survival: 0, economy: 0.6, frontline: 0.6, vision: 0.45, objectives: 0.6, utility: 0.6, matchup: 0.6 };
  for (let index = 0; index < 20; index += 1) {
    const verdict = buildVerdict(seededSupport({ matchId: `NA1_${7000 + index}`, scoreAbove: 4, dimensions }));
    assert.equal(verdict.drags[0].dimension, "survival");
    assert.equal(verdict.drags[0].key, false);
    const summary = verdictSummary(verdict, true);
    assert.match(summary, /^生存只超过 0% 的同位置玩家，/);
    assert.ok(!summary.includes("最看重"), summary);
  }
  for (let index = 0; index < 20; index += 1) {
    const unknown = verdictSummary(buildVerdict(seededSupport({ matchId: `NA1_${8000 + index}`, position: null, scoreAbove: 4 })), true);
    assert.ok(!unknown.includes("未知位置最看重"), unknown);
  }
  const keyWorst = Array.from({ length: 20 }, (_, index) => verdictSummary(buildVerdict(seededSupport({ matchId: `NA1_${9000 + index}`, scoreAbove: 4 })), true));
  assert.ok(keyWorst.some((summary) => summary.includes("这是辅助最看重的地方之一")), "a key worst dimension can still be called that");
});

test("an ADC with a red frontline is not told every item is above the median", () => {
  const record = makeHorseRecord({
    position: "BOTTOM", tier: "下等马", teamRank: 4, score: 5.2, scoreAbove: 6.5,
    dimensions: { damage: 0.6, teamfight: 0.6, survival: 0.6, economy: 0.6, frontline: 0.1, vision: 0.6, objectives: 0.6, utility: 0.6, matchup: 0.6 },
  });
  const verdict = buildVerdict(record);
  assert.deepEqual(verdict.drags, [], "frontline has no weight for a bottom laner");
  assert.equal(verdict.allAboveMedian, false);
  assert.match(verdictSummary(verdict, true), /^计入评分的每一项都在同位置中位数以上/);
  assert.match(appealRuling(verdict), /呈堂证供：计入评分的每一项都在同位置中位数以上/);
  const clean = buildVerdict({ ...record, dimensions: { ...record.dimensions, frontline: 0.5 } });
  assert.match(verdictSummary(clean, true), /^每一项都在同位置中位数以上/);
});

test("in a team larger than five a neighbour of the same tier is named by place", () => {
  // Ranks 2 and 3 of seven are both 上等马.
  const verdict = buildVerdict(makeHorseRecord({ tier: "上等马", teamRank: 3, teamSize: 7, score: 6, scoreAbove: 6.2, scoreBelow: 5.9 }));
  assert.equal(verdict.above?.sameTier, true);
  assert.equal(verdict.below?.tier, "中等马");
  assert.equal(verdict.below?.sameTier, false);
  assert.match(verdictSummary(verdict, true), /^离上一名只差 0\.2 分，惜败/);
  const ruling = appealRuling(verdict);
  assert.match(ruling, /离上一名只差 0\.2 分/);
  assert.ok(!ruling.includes("离上等马"), ruling);
  const sameBelow = appealRuling(buildVerdict(makeHorseRecord({ tier: "上等马", teamRank: 2, teamSize: 7, score: 6.2, scoreAbove: 7, scoreBelow: 6 })));
  assert.match(sameBelow, /你只比下一名多 0\.2 分，这是险胜。/);
  assert.ok(!sameBelow.includes("改判成上等马"), sameBelow);
});

test("the summary admits 惜败, names the costliest dimension, and says 你 only to the member", () => {
  const support = buildVerdict(seededSupport());
  assert.equal(verdictSummary(support, true), "离下等马只差 0.2 分，惜败，多插几个眼就上去了。");

  const clear = buildVerdict(seededSupport({ scoreAbove: 3.4 }));
  const mine = verdictSummary(clear, true);
  const theirs = verdictSummary(clear, false);
  assert.match(mine, /^视野只超过 9% 的同位置玩家，/);
  assert.ok(!theirs.includes("你"), theirs);
  assert.equal(verdictSummary(clear, true), mine, "the same verdict always reads the same");

  const top = verdictSummary(buildVerdict(seededJungler()), false);
  assert.match(top, /^资源超过 97% 的同位置玩家，/);
  assert.ok(!top.includes("你"), top);

  const outclassed = buildVerdict(makeHorseRecord({ tier: "下等马", teamRank: 4, score: 5.2, scoreAbove: 6.5, dimensions: { damage: 0.6, teamfight: 0.7 } }));
  assert.match(verdictSummary(outclassed, true), /每一项都在同位置中位数以上，只是队友更猛/);
});

test("an appeal is always 维持原判, cites the strongest data and admits 惜败", () => {
  const ruling = appealRuling(buildVerdict(seededSupport()));
  const lines = ruling.split("\n");
  assert.match(lines[0], /^<@support-friend> .*没有马/);
  assert.equal(lines[1], "呈堂证供：视野只超过 9% 的同位置玩家，而这一项在这局辅助评分里占 22%，每分钟视野得分 0.8，插了 3 个真眼。");
  assert.match(lines[2], /^军师承认这一局是惜败，离下等马只差 0\.2 分。可差一点也是差，驳回上诉，维持原判：没有马。/);
  assert.equal(appealRuling(buildVerdict(seededSupport())), ruling, "deterministic for the same match and appellant");
});

test("a clear verdict is upheld without admitting anything", () => {
  const ruling = appealRuling(buildVerdict(seededSupport({ scoreAbove: 3.4 })));
  assert.ok(!ruling.includes("惜败") && !ruling.includes("险胜"), ruling);
  assert.match(ruling, /驳回上诉，维持原判：没有马。/);
});

test("a 特等马 who appeals is told there is nothing higher and that the margin was 险胜", () => {
  const ruling = appealRuling(buildVerdict(seededJungler()));
  assert.match(ruling, /没有比特等马更高的档位了/);
  assert.match(ruling, /你只比上等马多 0\.2 分，这是险胜/);
  assert.match(ruling, /维持原判：特等马。/);
});

test("an appeal with nothing below the median cites the gap instead", () => {
  const ruling = appealRuling(buildVerdict(makeHorseRecord({ tier: "下等马", teamRank: 4, score: 5.2, scoreAbove: 6.5, dimensions: { damage: 0.6 } })));
  assert.match(ruling, /每一项都在同位置中位数以上，但队内第 3 名比你高 1\.3 分/);
  assert.match(ruling, /维持原判：下等马。/);
});

test("appeal wording varies by match and stays about play", () => {
  const rulings = new Set(Array.from({ length: 12 }, (_, index) => appealRuling(buildVerdict(seededSupport({ matchId: `NA1_${6000 + index}` })))));
  assert.ok(rulings.size > 1, "the opener and closer are picked per match");
  for (const ruling of rulings) assert.doesNotMatch(ruling, /长相|丑|胖|爸|妈|家里|性别|种族/);
});

test("selection defaults to the latest record of the right kind and finds a chosen match", () => {
  const base = { guildId: "g", discordUserId: "friend", puuid: "p" };
  recordTracked([
    makeHorseRecord({ ...base, matchId: "NA1_100", playedAt: 1_000 }),
    makeHorseRecord({ ...base, matchId: "NA1_200", playedAt: 2_000 }),
    makeHorseRecord({ ...base, matchId: "NA1_300", playedAt: 3_000, mock: true }),
    makeHorseRecord({ ...base, discordUserId: "other", puuid: "q", matchId: "NA1_400", playedAt: 4_000 }),
  ]);
  assert.equal(findVerdictRecord("g", "friend", false)?.matchId, "NA1_200");
  assert.equal(findVerdictRecord("g", "friend", true)?.matchId, "NA1_300");
  assert.equal(findVerdictRecord("g", "friend", false, "NA1_100")?.matchId, "NA1_100");
  assert.equal(findVerdictRecord("g", "friend", false, "100")?.matchId, "NA1_100", "a bare number is read as an NA1 match");
  assert.equal(findVerdictRecord("g", "friend", false, "NA1_300"), undefined, "a mock record is not found in real mode");
  assert.equal(findVerdictRecord("g", "friend", false, "NA1_400"), undefined, "another member's match is not theirs");
  assert.equal(findVerdictRecord("g", "nobody", false), undefined);
  assert.deepEqual(listVerdictChoices("g", "friend", false).map((record) => record.matchId), ["NA1_200", "NA1_100"]);
});
