/** At most this many Riot accounts across all tracked members of one server. */
export const MAX_ACCOUNTS_PER_GUILD = 10;

/** A Riot account can belong to only one tracked member per server. */
export class AccountBoundToOtherMemberError extends Error {
  constructor(readonly puuid: string, readonly ownerId: string) {
    super(`Riot account ${puuid} is already bound to Discord member ${ownerId}.`);
    this.name = "AccountBoundToOtherMemberError";
  }
}

export class GuildAccountLimitError extends Error {
  constructor(readonly limit: number = MAX_ACCOUNTS_PER_GUILD) {
    super(`A server can track at most ${limit} Riot accounts.`);
    this.name = "GuildAccountLimitError";
  }
}

/** A record (horse or LP result) was refused because its member does not currently own that Riot account in the server. */
export class UntrackedMemberError extends Error {
  constructor(readonly guildId: string, readonly discordUserId: string, readonly puuid: string) {
    super("A record can only be saved for a member who is still tracked and owns that Riot account.");
    this.name = "UntrackedMemberError";
  }
}
