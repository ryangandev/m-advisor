import { getTrackedMember, setMemberAccounts } from "../../src/store/bindingStore";
import { recordRankResults, type RankResult } from "../../src/store/rankStore";

/** Binds each result's account to its member when it is not bound yet, then stores the results, as the monitor's owners always are. */
export function recordTrackedRanks(results: readonly RankResult[]): number {
  for (const { guildId, discordUserId, puuid } of results) {
    const known = getTrackedMember(guildId, discordUserId)?.accounts ?? [];
    if (known.some((account) => account.puuid === puuid)) continue;
    setMemberAccounts(guildId, discordUserId, [...known, { puuid, gameName: `Name ${discordUserId}`, tagLine: "NA1" }]);
  }
  return recordRankResults(results);
}
