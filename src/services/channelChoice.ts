import type { Client, VoiceChannel } from "discord.js";
import type { TrackedMember } from "../types";

/** A member's current voice channel if announcements may play there, otherwise null. */
export type ResolveChannel = (client: Client, guildId: string, userId: string) => VoiceChannel | null;

/** A tracked member's account that took part in a game, finished or about to start. */
export interface BoundParticipant {
  memberId: string;
  puuid: string;
  teamId: number;
}

/** People in a channel other than bots; used only to break a tie between channels. */
function humanCount(channel: VoiceChannel): number {
  let count = 0;
  for (const member of channel.members.values()) {
    if (!(member as { user?: { bot?: boolean } }).user?.bot) count++;
  }
  return count;
}

/**
 * Every tracked member's account among the players, in bind order, once per account.
 * Whether or not the member is in voice: callers filter by presence where it matters.
 */
export function boundParticipants(members: readonly TrackedMember[], players: ReadonlyArray<{ puuid: string | null; teamId: number }>): BoundParticipant[] {
  const result: BoundParticipant[] = [];
  for (const member of members) {
    for (const account of member.accounts) {
      const player = players.find((candidate) => candidate.puuid === account.puuid);
      if (player && !result.some((entry) => entry.puuid === account.puuid)) {
        result.push({ memberId: member.discordUserId, puuid: account.puuid, teamId: player.teamId });
      }
    }
  }
  return result;
}

/** The participants who still own the account they played on, in bind order; read live, so an unbound member drops out. */
export function liveParticipants(members: readonly TrackedMember[], participants: readonly BoundParticipant[]): BoundParticipant[] {
  return participants.filter((participant) => members.some((member) =>
    member.discordUserId === participant.memberId && member.accounts.some((account) => account.puuid === participant.puuid)));
}

/** The distinct members among the live participants, in bind order. */
export function liveParticipantIds(members: readonly TrackedMember[], participants: readonly BoundParticipant[]): string[] {
  return [...new Set(liveParticipants(members, participants).map((participant) => participant.memberId))];
}

/**
 * The channel with the most participating tracked members.
 * Ties keep the previous pick, then go to the channel with more people, then the earliest-bound member's channel, then the lower ID.
 */
export function chooseChannel(
  resolveChannel: ResolveChannel,
  client: Client,
  guildId: string,
  participatingMemberIds: readonly string[],
  previousId?: string,
): VoiceChannel | null {
  const tallies = new Map<string, { channel: VoiceChannel; members: number; order: number }>();
  participatingMemberIds.forEach((memberId, order) => {
    const channel = resolveChannel(client, guildId, memberId);
    if (!channel) return;
    const tally = tallies.get(channel.id);
    if (tally) tally.members++;
    else tallies.set(channel.id, { channel, members: 1, order });
  });
  const ranked = [...tallies.values()].sort((a, b) => b.members - a.members
    || Number(b.channel.id === previousId) - Number(a.channel.id === previousId)
    || humanCount(b.channel) - humanCount(a.channel)
    || a.order - b.order
    || (a.channel.id < b.channel.id ? -1 : a.channel.id > b.channel.id ? 1 : 0));
  return ranked[0]?.channel ?? null;
}

/**
 * The team with the most participating members in the channel, then the earliest-bound member's team; that team's earliest-bound member speaks.
 * Members the session covers (`isPresent`) are preferred, since the speaker must still be in voice when playback starts.
 */
export function perspective(
  resolveChannel: ResolveChannel,
  client: Client,
  guildId: string,
  isPresent: (memberId: string) => boolean,
  participants: readonly BoundParticipant[],
  channel: VoiceChannel,
): BoundParticipant | undefined {
  const inChannel = participants.filter((participant) => resolveChannel(client, guildId, participant.memberId)?.id === channel.id);
  const present = inChannel.filter((participant) => isPresent(participant.memberId));
  const pool = present.length > 0 ? present : inChannel.length > 0 ? inChannel : participants;
  const teamSize = (teamId: number) => pool.filter((participant) => participant.teamId === teamId).length;
  const largest = Math.max(...pool.map((participant) => teamSize(participant.teamId)));
  return pool.find((participant) => teamSize(participant.teamId) === largest);
}
