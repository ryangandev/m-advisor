import { RiotAccount, ServerBinding } from "../types";

export function isSyntheticAccount(account: RiotAccount): boolean {
  return account.puuid.startsWith("MOCK-");
}

/** Refresh identities atomically when a mock Riot ID is rebound with real data. */
export function mergeBoundAccount(accounts: RiotAccount[], account: RiotAccount): RiotAccount[] {
  const sameIdentity = (bound: RiotAccount) => bound.puuid === account.puuid ||
    (bound.gameName.toLowerCase() === account.gameName.toLowerCase() && bound.tagLine.toLowerCase() === account.tagLine.toLowerCase());
  const index = accounts.findIndex(sameIdentity);
  if (index < 0) return [...accounts, account];
  return accounts.flatMap((bound, position) => position === index ? [account] : sameIdentity(bound) ? [] : [bound]);
}

/** One warning per saved mock account, which real mode never monitors. */
export function skippedMockAccountWarnings(
  bindings: Array<{ guildId: string; binding: ServerBinding }>,
  serverName: (guildId: string) => string = (guildId) => guildId,
): string[] {
  return bindings.flatMap(({ guildId, binding }) => binding.accounts.filter(isSyntheticAccount).map((account) =>
    `Real mode skips the saved mock account ${account.gameName}#${account.tagLine} in server ${serverName(guildId)}; `
    + "use /bind with a real Riot ID to replace it."));
}
