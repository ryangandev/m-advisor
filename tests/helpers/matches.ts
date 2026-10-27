import { buildMockMatch, buildMockProfile, buildMockTimeline, type MockOutcome, type RawMatch } from "../../src/fixtures/riotFixtures";
import { parseMatchTimeline, type MatchTimeline } from "../../src/utils/matchTimeline";
import { parseMatchDetail } from "../../src/utils/riotMatchApi";
import type { MatchDetail } from "../../src/types";

function rawTestMatch(matchId: string, trackedPuuids: string[], outcome: MockOutcome): RawMatch {
  const profile = buildMockProfile("Tracked", "NA1");
  profile.account.puuid = trackedPuuids[0];
  const raw = buildMockMatch(profile, matchId, outcome);
  const participants = raw.info.participants as Array<Record<string, unknown>>;
  // Neutral names keep real-mode tests free of the fixture's 模拟 labels.
  participants.forEach((participant, index) => {
    if (index > 0) participant.riotIdGameName = index < 5 ? `Ally${index}` : `Enemy${index - 4}`;
  });
  trackedPuuids.slice(1).forEach((puuid, index) => {
    participants[index + 1].puuid = puuid;
    participants[index + 1].riotIdGameName = "Tracked";
  });
  raw.metadata.participants = participants.map((participant) => participant.puuid as string);
  return raw;
}

/**
 * A complete, parsed 5v5 match from the labeled mock fixture. The first tracked PUUID plays mid;
 * further tracked PUUIDs replace allies so shared-match scenarios stay on one team.
 */
export function testMatch(matchId: string, trackedPuuids: string[], outcome: MockOutcome = "loss"): MatchDetail {
  return parseMatchDetail(rawTestMatch(matchId, trackedPuuids, outcome), matchId);
}

/** The same match with its parsed mock timeline. */
export function testMatchWithTimeline(matchId: string, trackedPuuids: string[], outcome: MockOutcome = "loss"): { detail: MatchDetail; timeline: MatchTimeline } {
  const raw = rawTestMatch(matchId, trackedPuuids, outcome);
  return { detail: parseMatchDetail(raw, matchId), timeline: parseMatchTimeline(buildMockTimeline(raw), matchId) };
}
