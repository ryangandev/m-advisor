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

  const atThreshold = buildVerdict(makeHorseRecord({ score: 5, scoreAbove: 5 + CLOSE_GAP, scoreBelow: 5 - CLOSE_GAP - 0.01 }));
  assert.equal(atThreshold.above?.close, true, "0.3 points is still 惜败");
  assert.equal(atThreshold.below?.close, false, "0.31 points is no longer 险胜");
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
  assert.deepEqual(dimensionEvidence("vision", record), ["每分钟视野得分 0.8", "全场 3 个真眼"]);
  assert.deepEqual(dimensionEvidence("teamfight", record), ["参团率 24%", "0/9/4"]);
  assert.deepEqual(dimensionEvidence("matchup", makeHorseRecord({ durationSeconds: 1200, features: { goldDiffPerMinute: -40 } })), ["比对位少 800 经济"]);
  assert.deepEqual(dimensionEvidence("frontline", makeHorseRecord({ features: {} })), []);
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
  assert.equal(lines[1], "呈堂证供：视野只超过 9% 的同位置玩家，而这一项占辅助评分的 22%，每分钟视野得分 0.8，全场 3 个真眼。");
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
