import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMatchAnnouncement, seededChooser } from "../src/services/announcementText";
import { HORSE_TIERS, rankTeam } from "../src/services/horseRanking";
import type { HorseTier } from "../src/services/horseRanking";
import { buildPartyRanking, PARTY_SENTENCE_LIMIT } from "../src/services/partyRanking";
import type { PartyHorse, PartyMember } from "../src/services/partyRanking";
import { buildPartyEmbed } from "../src/utils/embeds";
import type { MatchDetail } from "../src/types";
import { testMatch } from "./helpers/matches";

const TIER_WORDS = /特等马|上等马|中等马|下等马|没有马/;

/** A five-horse team already in ranking order, with the given display names. */
function team(names: string[] = ["甲", "乙", "丙", "丁", "戊"]): PartyHorse[] {
  return names.map((name, index) => ({
    puuid: `p${index + 1}`,
    tier: HORSE_TIERS[index] as HorseTier,
    score: 9 - index * 2,
    champion: `英雄${index + 1}`,
    name,
  }));
}
const members = (...ranks: number[]): PartyMember[] => ranks.map((rank) => ({ memberId: `m${rank}`, puuid: `p${rank}` }));
const first = <T>(options: readonly T[]) => options[0];

test("two friends are ranked among themselves in team order with the lowest score blamed", () => {
  const party = buildPartyRanking({ team: team(), party: members(4, 2), mock: false, choose: first })!;
  assert.deepEqual(party.entries.map((entry) => [entry.memberId, entry.teamRank, entry.teamSize, entry.tier, entry.score]), [
    ["m2", 2, 5, "上等马", 7],
    ["m4", 4, 5, "下等马", 3],
  ]);
  assert.equal(party.best[0].memberId, "m2");
  assert.equal(party.worst[0].memberId, "m4");
  assert.equal(party.sentence, "车队内战，乙最好，丁背锅。");
  assert.equal(party.relative, false);
});

test("three friends keep the team's order whatever order the caller lists them in", () => {
  const party = buildPartyRanking({ team: team(), party: members(5, 1, 3), mock: false, choose: first })!;
  assert.deepEqual(party.entries.map((entry) => entry.memberId), ["m1", "m3", "m5"]);
  assert.equal(party.best[0].memberId, "m1");
  assert.equal(party.worst[0].memberId, "m5");
  assert.equal(party.sentence, "车队内战，甲最好，戊背锅。");
});

test("equal scores keep the team's order", () => {
  const tied = team().map((horse) => ({ ...horse, score: 5 }));
  const party = buildPartyRanking({ team: tied, party: members(3, 2), mock: false, choose: first })!;
  assert.deepEqual(party.entries.map((entry) => entry.memberId), ["m2", "m3"]);
});

test("fewer than two members on the team is no party", () => {
  assert.equal(buildPartyRanking({ team: team(), party: [], mock: false, choose: first }), undefined);
  assert.equal(buildPartyRanking({ team: team(), party: members(3), mock: false, choose: first }), undefined);
  // The second account is not on the team, so it is an enemy and cannot make a party.
  const outsider = [...members(3), { memberId: "zed-id", puuid: "enemy" }];
  assert.equal(buildPartyRanking({ team: team(), party: outsider, mock: false, choose: first }), undefined);
  // One member with two accounts is still one member.
  const twice = [{ memberId: "m1", puuid: "p1" }, { memberId: "m1", puuid: "p2" }];
  assert.equal(buildPartyRanking({ team: team(), party: twice, mock: false, choose: first }), undefined);
});

test("a friend who is not on the team is never ranked, named or quoted", () => {
  const party = buildPartyRanking({
    team: team(),
    party: [...members(1, 4), { memberId: "zed-id", puuid: "enemy" }],
    mock: false,
    choose: first,
  })!;
  assert.deepEqual(party.entries.map((entry) => entry.memberId), ["m1", "m4"]);
  assert.doesNotMatch(JSON.stringify(party), /zed|enemy/);
});

test("a scapegoat who is still 特等马 or 上等马 is blamed only relatively and kindly", () => {
  const party = buildPartyRanking({ team: team(), party: members(1, 2), mock: false, choose: first })!;
  assert.equal(party.worst[0].tier, "上等马");
  assert.equal(party.relative, true);
  assert.equal(party.sentence, "车队内战，甲最好，乙今天只是相对背锅。");
  assert.match(party.worstLine, /相对/);
  const harsh = buildPartyRanking({ team: team(), party: members(1, 3), mock: false, choose: first })!;
  assert.equal(harsh.relative, false);
  assert.doesNotMatch(harsh.sentence, /相对/);
  assert.doesNotMatch(harsh.worstLine, /相对/);
});

test("the sentence names no tier, so it cannot clash with the tier roll", () => {
  for (const ranks of [[1, 2], [2, 3], [3, 4], [4, 5], [1, 5]]) {
    const party = buildPartyRanking({ team: team(), party: members(...ranks), mock: false, choose: first })!;
    for (const text of [party.sentence, party.bestLine, party.worstLine]) assert.doesNotMatch(text, TIER_WORDS);
  }
});

test("every wording choice stays play-only and fits the length cap with long names", () => {
  const long = ["龙".repeat(32), "A".repeat(32), "名字特别长的召唤师", "x", "y"];
  for (const ranks of [[1, 2], [1, 5], [2, 3], [3, 4]]) {
    for (let seed = 0; seed < 30; seed++) {
      const party = buildPartyRanking({ team: team(long), party: members(...ranks), mock: false, choose: seededChooser(`seed-${seed}`) })!;
      assert.ok(Array.from(party.sentence).length <= PARTY_SENTENCE_LIMIT, `${party.sentence} is ${Array.from(party.sentence).length} characters`);
      assert.match(party.sentence, /^车队内战，.+(最好|领跑|夺魁)，.+背锅。$/);
      for (const text of [party.sentence, party.bestLine, party.worstLine]) assert.doesNotMatch(text, /长相|外貌|家人|妈|爸|丑/);
    }
  }
});

test("a trimmed name keeps whole characters and a short name is untouched", () => {
  const party = buildPartyRanking({ team: team(["𠮷".repeat(20), "短", "丙", "丁", "戊"]), party: members(1, 2), mock: false, choose: first })!;
  assert.ok(party.sentence.includes("短"));
  assert.doesNotMatch(party.sentence, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, "no split surrogate pair");
  assert.ok(Array.from(party.sentence).length <= PARTY_SENTENCE_LIMIT);
});

test("the same input always gives the same party", () => {
  const input = { team: team(), party: members(1, 3, 4), mock: true };
  assert.deepEqual(
    buildPartyRanking({ ...input, choose: seededChooser("M:party") }),
    buildPartyRanking({ ...input, choose: seededChooser("M:party") }),
  );
});

// A best member who is only 中等马 or lower, name collisions and ties.

test("a best member who is only 中等马 or lower is the relatively best, never the leader", () => {
  const duo = buildPartyRanking({ team: team(), party: members(4, 5), mock: false, choose: first })!;
  assert.equal(duo.best[0].tier, "下等马");
  assert.equal(duo.modest, true);
  assert.equal(duo.sentence, "车队内战，丁相对最好，戊背锅。");
  assert.equal(duo.bestLine, "车队里你相对靠前，下把争取真领跑。");
  const middle = buildPartyRanking({ team: team(), party: members(3, 5), mock: false, choose: first })!;
  assert.equal(middle.best[0].tier, "中等马");
  assert.equal(middle.sentence, "车队内战，丙相对最好，戊背锅。");
  for (const ranks of [[3, 4], [3, 5], [4, 5]]) {
    for (let seed = 0; seed < 20; seed++) {
      const party = buildPartyRanking({ team: team(), party: members(...ranks), mock: false, choose: seededChooser(`modest-${seed}`) })!;
      for (const text of [party.sentence, party.bestLine]) assert.doesNotMatch(text, /夺魁|领跑整个|主心骨|最稳|最前面|矮子里拔将军/);
      assert.match(party.sentence, /相对最好/);
    }
  }
  // A 上等马 best member keeps the confident wording.
  const strong = buildPartyRanking({ team: team(), party: members(2, 3), mock: false, choose: first })!;
  assert.equal(strong.modest, false);
  assert.equal(strong.sentence, "车队内战，乙最好，丙背锅。");
});

test("the embed marks a modest MVP as relative", () => {
  const modest = buildPartyEmbed(buildPartyRanking({ team: team(), party: members(4, 5), mock: false, choose: first })!).toJSON();
  assert.equal(modest.fields![1].name, "👑 车队 MVP (相对)");
  const strong = buildPartyEmbed(buildPartyRanking({ team: team(), party: members(1, 2), mock: false, choose: first })!).toJSON();
  assert.equal(strong.fields![1].name, "👑 车队 MVP");
});

test("names that collide after trimming stay distinguishable in both the normal and the relative budget", () => {
  const spoken = (ranks: number[], list: string[]) => {
    const party = buildPartyRanking({ team: team(list), party: members(...ranks), mock: false, choose: first })!;
    const match = party.sentence.match(/^车队内战，(.+?)最好，(.+?)(?:今天只是相对背锅|背锅)。$/)!;
    assert.ok(match, party.sentence);
    assert.ok(Array.from(party.sentence).length <= PARTY_SENTENCE_LIMIT, party.sentence);
    return { party, first: match[1], second: match[2] };
  };
  const normal = spoken([1, 3], ["ProPlayer01", "x", "ProPlayer02", "y", "z"]);
  assert.equal(normal.party.relative, false);
  assert.notEqual(normal.first, normal.second, normal.party.sentence);
  assert.ok(normal.first.endsWith("01") && normal.second.endsWith("02"), "the distinguishing end is kept: " + normal.party.sentence);
  const relative = spoken([1, 2], ["ProPlayer01", "ProPlayer02", "x", "y", "z"]);
  assert.equal(relative.party.relative, true);
  assert.notEqual(relative.first, relative.second, relative.party.sentence);
  assert.ok(relative.first.endsWith("01") && relative.second.endsWith("02"), "the distinguishing end is kept: " + relative.party.sentence);
  // Names that differ at the front keep their fronts.
  for (const ranks of [[1, 3], [1, 2]]) {
    const front = spoken(ranks, ["01ProPlayer", "02ProPlayer", "03ProPlayer", "y", "z"]);
    assert.notEqual(front.first, front.second, front.party.sentence);
  }
});

test("names that collide at both ends, or are identical, fall back to the champions", () => {
  const both = buildPartyRanking({
    team: team(["Aaaaaaaa1aaaaaaaa", "Aaaaaaaa2aaaaaaaa", "丙", "丁", "戊"]), party: members(1, 2), mock: false, choose: first,
  })!;
  assert.equal(both.sentence, "车队内战，英雄1最好，英雄2今天只是相对背锅。");
  const same = buildPartyRanking({ team: team(["Bob", "丁", "丙", "Bob", "戊"]), party: members(1, 4), mock: false, choose: first })!;
  assert.equal(same.sentence, "车队内战，英雄1最好，英雄4背锅。");
  // Distinct short names are spoken whole.
  const whole = buildPartyRanking({ team: team(["Bob", "Alice", "丙", "丁", "戊"]), party: members(1, 4), mock: false, choose: first })!;
  assert.equal(whole.sentence, "车队内战，Bob最好，丁背锅。");
});

test("when everyone shares one score there is no MVP and no 背锅", () => {
  const tied = team().map((horse) => ({ ...horse, score: 5 }));
  const duo = buildPartyRanking({ team: tied, party: members(2, 4), mock: false, choose: first })!;
  assert.equal(duo.tiedAll, true);
  assert.deepEqual(duo.worst, []);
  assert.equal(duo.sentence, "车队内战，乙和丁并列。");
  assert.equal(duo.worstLine, "");
  assert.doesNotMatch(duo.bestLine, /MVP|领跑|最好/);
  assert.match(duo.bestLine, /没人背锅/);
  const trio = buildPartyRanking({ team: tied, party: members(1, 3, 5), mock: false, choose: first })!;
  assert.equal(trio.sentence, "车队内战，甲、丙和戊并列。");
  const embed = buildPartyEmbed(trio).toJSON();
  assert.deepEqual(embed.fields!.map((field) => field.name), ["车队内部排名", "🤝 车队并列"]);
  assert.match(embed.fields![1].value, /<@m1>[\s\S]*<@m3>[\s\S]*<@m5>/);
  assert.doesNotMatch(JSON.stringify(embed.fields!.map((field) => field.name)), /MVP|背锅/);
});

test("tied top scores share the MVP, tied bottom scores name no single 背锅", () => {
  const scores = (values: number[]) => team().map((horse, index) => ({ ...horse, score: values[index] }));
  const top = buildPartyRanking({ team: scores([8, 8, 3, 2, 1]), party: members(1, 2, 3), mock: false, choose: first })!;
  assert.deepEqual(top.best.map((entry) => entry.memberId), ["m1", "m2"]);
  assert.equal(top.sentence, "车队内战，甲和乙并列最好，丙背锅。");
  const topEmbed = buildPartyEmbed(top).toJSON();
  assert.equal(topEmbed.fields![1].name, "👑 车队 MVP 并列");
  assert.match(topEmbed.fields![1].value, /<@m1>[\s\S]*<@m2>/);
  assert.equal(topEmbed.fields![2].name, "🍳 本局背锅");

  const bottom = buildPartyRanking({ team: scores([9, 5, 5, 2, 1]), party: members(1, 2, 3), mock: false, choose: first })!;
  assert.deepEqual(bottom.worst.map((entry) => entry.memberId), ["m2", "m3"]);
  assert.equal(bottom.sentence, "车队内战，甲最好，乙和丙并列垫底。");
  assert.equal(bottom.relative, false);
  const bottomEmbed = buildPartyEmbed(bottom).toJSON();
  assert.deepEqual(bottomEmbed.fields!.map((field) => field.name), ["车队内部排名", "👑 车队 MVP", "🤝 垫底并列 (无人背锅)"]);
  assert.match(bottomEmbed.fields![2].value, /<@m2>[\s\S]*<@m3>/);
  assert.doesNotMatch(JSON.stringify(bottomEmbed), /本局背锅/);

  // A tied top that is only 中等马 or lower claims no more than "靠前".
  const lowTie = buildPartyRanking({ team: scores([9, 8, 3, 3, 1]), party: members(3, 4, 5), mock: false, choose: first })!;
  assert.equal(lowTie.sentence, "车队内战，丙和丁并列靠前，戊背锅。");
});

test("the sentence fits the cap for every tie shape with long names", () => {
  const long = ["龙".repeat(32), "A".repeat(31) + "1", "A".repeat(31) + "2", "名字特别长的召唤师", "x".repeat(30)];
  const shapes: number[][] = [
    [9, 7, 5, 3, 1], [5, 5, 5, 5, 5], [9, 9, 3, 3, 3], [9, 9, 9, 3, 3], [9, 3, 3, 3, 3], [9, 9, 9, 9, 3], [3, 3, 3, 3, 1], [4, 4, 3, 3, 3],
  ];
  for (const values of shapes) {
    for (let size = 2; size <= 5; size++) {
      for (let seed = 0; seed < 8; seed++) {
        const horses = team(long).map((horse, index) => ({ ...horse, score: values[index] }));
        const party = buildPartyRanking({ team: horses, party: members(...[1, 2, 3, 4, 5].slice(0, size)), mock: false, choose: seededChooser(`shape-${seed}`) });
        assert.ok(party);
        assert.ok(Array.from(party.sentence).length <= PARTY_SENTENCE_LIMIT, `${values} x${size}: ${party.sentence}`);
        assert.match(party.sentence, /^车队内战，.+。$/);
      }
    }
  }
});

// Through the real announcement builder.

/** A match whose team-100 horses are ranked by the real model; returns the detail and that team's PUUIDs, best first. */
function rankedMatch(matchId: string): { detail: MatchDetail; order: string[] } {
  const detail = testMatch(matchId, ["alice", "bob", "cara", "dan", "eve"], "win");
  detail.info.participants.slice(0, 5).forEach((player, index) => { player.riotIdGameName = ["Alice", "Bob", "Cara", "Dan", "Eve"][index]; });
  detail.info.participants.slice(5).forEach((player, index) => { player.riotIdGameName = `Zed${index}`; });
  const order = rankTeam(detail, "alice").horses.map((horse) => horse.participant.puuid);
  return { detail, order };
}
const memberOf = (puuid: string): PartyMember => ({ memberId: `${puuid}-id`, puuid });

test("the announcement ends with the party sentence and carries the party, leaving the report itself unchanged", () => {
  const { detail, order } = rankedMatch("PARTY-A");
  const plain = buildMatchAnnouncement(detail, "alice", true);
  const friends = [order[3], order[0], order[2]];
  const withParty = buildMatchAnnouncement(detail, "alice", true, { party: friends.map(memberOf) });
  const party = withParty.party!;
  assert.deepEqual(party.entries.map((entry) => entry.puuid), [order[0], order[2], order[3]]);
  assert.equal(withParty.speech, `${plain.speech}${party.sentence}`);
  assert.deepEqual(withParty.report, plain.report);
  assert.ok(withParty.speech.endsWith("。"));
  assert.match(party.sentence, /^车队内战，/);
  // The ranking is the team ranking's own: the printed scores and ranks match the report lines.
  party.entries.forEach((entry) => {
    const line = plain.report.lines[entry.teamRank - 1];
    assert.equal(entry.score, line.score);
    assert.equal(entry.tier, line.tier);
    assert.equal(entry.name, line.name);
    assert.equal(entry.champion, line.champion);
    assert.equal(entry.teamRank, order.indexOf(entry.puuid) + 1);
  });
});

test("a party of one, or none, changes neither the speech nor the report", () => {
  const { detail, order } = rankedMatch("PARTY-B");
  const plain = buildMatchAnnouncement(detail, "alice", true);
  for (const party of [[], [memberOf(order[2])], [memberOf(order[2]), { memberId: "other", puuid: "unknown-puuid" }]]) {
    assert.deepEqual(buildMatchAnnouncement(detail, "alice", true, { party }), plain);
  }
});

test("a friend on the other team is not ranked or named in the speech or the embed", () => {
  const { detail, order } = rankedMatch("PARTY-C");
  const enemy = detail.info.participants.find((player) => player.teamId === 200)!;
  enemy.riotIdGameName = "EnemyFriend";
  const announcement = buildMatchAnnouncement(detail, "alice", true, {
    party: [memberOf(order[1]), memberOf(order[4]), { memberId: "enemy-friend-id", puuid: enemy.puuid }],
  });
  assert.deepEqual(announcement.party!.entries.map((entry) => entry.puuid), [order[1], order[4]]);
  const everything = JSON.stringify([announcement.speech, announcement.report, announcement.party, buildPartyEmbed(announcement.party!).toJSON()]);
  assert.doesNotMatch(everything, /EnemyFriend|enemy-friend-id/);
  // Only a friend on the other team and one on this team: no party at all.
  const alone = buildMatchAnnouncement(detail, "alice", true, {
    party: [memberOf(order[1]), { memberId: "enemy-friend-id", puuid: enemy.puuid }],
  });
  assert.equal(alone.party, undefined);
  assert.equal(alone.speech, buildMatchAnnouncement(detail, "alice", true).speech);
});

test("the party wording is deterministic and does not shift the report's own wording", () => {
  const { detail, order } = rankedMatch("PARTY-D");
  const party = [memberOf(order[0]), memberOf(order[4])].reverse();
  const first = buildMatchAnnouncement(detail, "alice", true, { party });
  assert.deepEqual(buildMatchAnnouncement(detail, "alice", true, { party }), first);
  assert.equal(first.speech.startsWith(buildMatchAnnouncement(detail, "alice", true).speech), true);
  // Different matches can word the party differently, but a given match always words it the same way.
  const sentences = new Set<string>();
  for (let index = 0; index < 40; index++) {
    const other = rankedMatch(`PARTY-D-${index}`);
    sentences.add(buildMatchAnnouncement(other.detail, "alice", true, { party: [memberOf(other.order[0]), memberOf(other.order[4])] }).party!.sentence);
  }
  assert.ok(sentences.size > 1, "the wording varies between matches");
});

test("games that are not judged have no party", () => {
  const { detail, order } = rankedMatch("PARTY-E");
  detail.info.earlySurrender = true;
  const announcement = buildMatchAnnouncement(detail, "alice", true, { party: [memberOf(order[0]), memberOf(order[1])] });
  assert.equal(announcement.party, undefined);
  assert.doesNotMatch(announcement.speech, /车队内战/);
  const short = rankedMatch("PARTY-F").detail;
  short.info.gameDuration = 7 * 60;
  assert.equal(buildMatchAnnouncement(short, "alice", true, { party: [memberOf("alice"), memberOf("bob")] }).party, undefined);
});

test("the speech sentence fits the cap when the friends have very long names", () => {
  const { detail, order } = rankedMatch("PARTY-G");
  for (const player of detail.info.participants) player.riotIdGameName = "@everyone <@1> ".repeat(8) + player.puuid;
  const party = buildMatchAnnouncement(detail, "alice", true, { party: [memberOf(order[0]), memberOf(order[1]), memberOf(order[4])] }).party!;
  assert.ok(Array.from(party.sentence).length <= PARTY_SENTENCE_LIMIT, party.sentence);
  assert.doesNotMatch(party.sentence, /@|<|>/);
});

test("a 上等马 scapegoat gets the kind wording in a real announcement", () => {
  const { detail, order } = rankedMatch("PARTY-H");
  const party = buildMatchAnnouncement(detail, "alice", true, { party: [memberOf(order[0]), memberOf(order[1])] }).party!;
  assert.equal(party.worst[0].tier, "上等马");
  assert.match(party.sentence, /相对背锅。$/);
});

// The embed.

test("the embed ranks the party with mentions, champions, tiers, scores and team ranks, then names the MVP and the 背锅", () => {
  const { detail, order } = rankedMatch("PARTY-I");
  const party = buildMatchAnnouncement(detail, "alice", false, { party: [memberOf(order[3]), memberOf(order[0]), memberOf(order[2])] }).party!;
  const json = buildPartyEmbed(party).toJSON();
  assert.equal(json.title, "车队内战");
  assert.match(json.footer!.text, /^Riot 实时数据/);
  const [ranking, mvp, blame] = json.fields!;
  assert.equal(ranking.name, "车队内部排名");
  const rows = ranking.value.split("\n");
  assert.equal(rows.length, 3);
  party.entries.forEach((entry, index) => {
    assert.ok(rows[index].startsWith(`${index + 1}. `));
    for (const piece of [`<@${entry.memberId}>`, entry.champion, `**${entry.tier}**`, `${entry.score.toFixed(1)} 分`, `队内第 ${entry.teamRank}/5`]) {
      assert.ok(rows[index].includes(piece), `${rows[index]} should include ${piece}`);
    }
  });
  assert.equal(mvp.name, "👑 车队 MVP");
  assert.ok(mvp.value.startsWith(`<@${party.best[0].memberId}>`));
  assert.ok(mvp.value.includes("军师："));
  assert.equal(blame.name, "🍳 本局背锅");
  assert.ok(blame.value.startsWith(`<@${party.worst[0].memberId}>`));
  assert.ok(blame.value.includes("军师："));
  assert.ok(JSON.stringify(json).length < 6000);
  assert.ok(json.fields!.every((field) => field.value.length <= 1024));
});

test("the embed is labeled in mock mode like the report and marks a relative blame", () => {
  const { detail, order } = rankedMatch("PARTY-J");
  const mock = buildMatchAnnouncement(detail, "alice", true, { party: [memberOf(order[0]), memberOf(order[1])] }).party!;
  const json = buildPartyEmbed(mock).toJSON();
  assert.match(json.title!, /^模拟战报 · 车队内战$/);
  assert.equal(json.footer!.text, "模拟数据 / Mock data • 策马军师");
  assert.equal(json.fields![2].name, "🍳 本局背锅 (相对)");
  assert.doesNotMatch(JSON.stringify(buildPartyEmbed({ ...mock, mock: false }).toJSON()), /模拟/);
});

test("names cannot turn into mentions inside the embed", () => {
  const { detail, order } = rankedMatch("PARTY-K");
  for (const player of detail.info.participants) player.riotIdGameName = "@everyone <@999> **bold**";
  const party = buildMatchAnnouncement(detail, "alice", true, { party: [memberOf(order[0]), memberOf(order[3])] }).party!;
  const text = JSON.stringify(buildPartyEmbed(party).toJSON());
  assert.doesNotMatch(text, /@everyone|<@999>|\*\*bold/);
});
