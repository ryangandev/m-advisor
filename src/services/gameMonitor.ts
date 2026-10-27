import { Client, VoiceChannel } from "discord.js";
import type { MatchDetail, RiotAccount, TrackedMember } from "../types";
import { listTrackedMembers } from "../store/bindingStore";
import {
  clearLastMatchIds,
  getAnnouncerState,
  getLastMatchId,
  resetAnnouncerRuntime,
  setLastMatchId,
  setPollingInterval,
} from "../store/announcerStore";
import { getLatestSRMatchId, getMatchDetail } from "../utils/riotMatchApi";
import { getRiotMode, RiotApiError } from "./riotData";
import { buildMatchAnnouncement } from "./announcementText";
import { buildHorseReportEmbed } from "../utils/embeds";
import { AnnouncementCancelledError, announceTextToCurrentChannel } from "./voiceAnnouncements";
import { logError, logInfo } from "../utils/log";

export const POLL_INTERVAL_MS = 45_000;
export interface PollResult { announced: number; errors: number }

/** What /recent shows about a guild's monitoring; the last error survives the session that raised it. */
export interface MonitorStatus {
  active: boolean;
  startedAt?: number;
  lastPollAt?: number;
  lastError?: { message: string; at: number };
  announced: ReadonlySet<string>;
  /** Tracked members the session currently covers, in bind order; empty when monitoring is off. */
  presentMemberIds: string[];
}

export interface MonitorDependencies {
  latest: (puuid: string) => Promise<string | null>;
  detail: (matchId: string) => Promise<MatchDetail>;
  /** Tracked members of a guild in bind order. */
  members: (guildId: string) => TrackedMember[];
  /** A member's current voice channel if announcements may play there, otherwise null. */
  resolveChannel: (client: Client, guildId: string, userId: string) => VoiceChannel | null;
  announce: typeof announceTextToCurrentChannel;
  mock: () => boolean;
  log: (error: unknown) => void;
  /** Progress messages for the operator, such as a newly detected match. */
  info: (message: string) => void;
}

/** A tracked member's account that took part in a match. */
export interface BoundParticipant {
  memberId: string;
  puuid: string;
  teamId: number;
}

/**
 * One finished match found by a poll, before it is announced.
 * Later features (in-party ranking, history) hook in here: they get every tracked player of the match and the chosen channel.
 */
export interface DetectedMatch {
  matchId: string;
  detail: MatchDetail;
  /** Every tracked member of the guild who played the match, in bind order, whether or not they are in voice. */
  boundParticipants: BoundParticipant[];
  /** The voice channel the announcement is aimed at when it is queued; it can follow a majority move later. */
  channelId: string;
}

interface PendingMatch {
  matchId: string;
  /** Polled accounts whose latest match this is; their baselines advance only after playback. */
  reporters: RiotAccount[];
  detail?: MatchDetail;
  detectedAt?: number;
}

interface PresentMember {
  since: number;
  /** The member's Riot IDs when they joined, for log lines after they are unbound. */
  label: string;
}

/** A present member's account as this session tracks it. */
interface AccountState {
  /** The member who owned the account when the session first saw it; another owner means a fresh start. */
  owner: string;
  /**
   * When the account joined a running session, because its member joined voice or it was added to a member in voice.
   * Its first lookup may wait behind a long poll, so a latest match that ended after this is announced instead of becoming the baseline.
   * Unset for accounts present when the session started, whose first lookup runs straight away.
   */
  since?: number;
  /** The first lookup has run: the baseline is recorded, or the latest match was kept as pending. */
  baselined: boolean;
}

/** A match none of whose players is in a usable voice channel; kept so later polls neither refetch nor relog it. */
interface WaitingMatch {
  detail: MatchDetail;
  detectedAt: number;
  /** Accounts that reported it; the entry is dropped once none of them is tracked any more. */
  reporters: Set<string>;
}

/** At most this many matches wait for a usable channel per session; the oldest is forgotten first. */
const WAITING_LIMIT = 20;

interface MonitorSession {
  startedAt: number;
  lastPollAt?: number;
  controller: AbortController;
  /** Tracked members in voice, in bind order. */
  present: Map<string, PresentMember>;
  /** Accounts of present members that this session has seen. */
  accounts: Map<string, AccountState>;
  announced: Set<string>;
  skippedMockAccounts: Set<string>;
  waiting: Map<string, WaitingMatch>;
  /** The channel of the latest announcement, kept so ties do not bounce between channels. */
  lastChannelId?: string;
  inFlight?: Promise<PollResult>;
  inFlightTargets?: Set<string>;
  /** Someone joined or gained an account while a poll was running, so poll again right after it. */
  pollAgain?: boolean;
}

function riotIds(accounts: RiotAccount[]): string {
  return accounts.map((account) => `${account.gameName}#${account.tagLine}`).join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isCredentialFailure(error: unknown): boolean {
  return error instanceof RiotApiError && ["missing_key", "unauthorized", "forbidden", "invalid_mode"].includes(error.code);
}

/** People in a channel other than bots; used only to break a tie between channels. */
function humanCount(channel: VoiceChannel): number {
  let count = 0;
  for (const member of channel.members.values()) {
    if (!(member as { user?: { bot?: boolean } }).user?.bot) count++;
  }
  return count;
}

/** Oldest finished match first; matches without an end time go last, then by match ID. */
function byGameEnd(a: PendingMatch, b: PendingMatch): number {
  const left = a.detail!.info.gameEndTimestamp;
  const right = b.detail!.info.gameEndTimestamp;
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }
  return a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0;
}

/** Public lifecycle with injectable I/O so tests exercise complete polling sessions. */
export class GameMonitor {
  private readonly sessions = new Map<string, MonitorSession>();
  private readonly lastErrors = new Map<string, { message: string; at: number }>();

  constructor(private readonly dependencies: MonitorDependencies) {}

  /**
   * Match the session to the tracked members who are in voice now.
   * No one present stops it; the first member starts it; a joining member gets a fresh baseline; a leaving member's baselines are dropped.
   * Channel moves do not touch the session.
   */
  sync(client: Client, guildId: string, presentMemberIds: Iterable<string>): void {
    const wanted = new Set(presentMemberIds);
    const members = this.dependencies.members(guildId).filter((member) => wanted.has(member.discordUserId));
    if (members.length === 0) {
      this.stop(guildId, "no tracked member is in voice");
      return;
    }
    let session = this.sessions.get(guildId);
    if (!session) {
      resetAnnouncerRuntime(guildId);
      const now = Date.now();
      session = {
        startedAt: now,
        controller: new AbortController(),
        present: new Map(members.map((member) => [member.discordUserId, { since: now, label: riotIds(member.accounts) }])),
        accounts: new Map(),
        announced: new Set(),
        skippedMockAccounts: new Set(),
        waiting: new Map(),
      };
      this.track(session, members);
      this.sessions.set(guildId, session);
      this.dependencies.info(`Monitoring started for ${members.map((member) => this.describe(client, guildId, member)).join("; ")}; `
        + `checking every ${POLL_INTERVAL_MS / 1000} s.`);
      const interval = setInterval(() => { void this.poll(client, guildId); }, POLL_INTERVAL_MS);
      interval.unref();
      setPollingInterval(guildId, interval);
      void this.poll(client, guildId);
      return;
    }
    const previous = session.present;
    const now = Date.now();
    session.present = new Map(members.map((member) => [
      member.discordUserId,
      previous.get(member.discordUserId) ?? { since: now, label: riotIds(member.accounts) },
    ]));
    for (const [memberId, { label }] of previous) {
      if (!session.present.has(memberId)) this.dependencies.info(`Monitoring no longer covers ${label}: they left voice or were unbound.`);
    }
    const joined = members.filter((member) => !previous.has(member.discordUserId));
    for (const member of joined) this.dependencies.info(`Monitoring now also covers ${this.describe(client, guildId, member)}.`);
    this.prune(guildId, session, members);
    this.track(session, members, now);
    const needsBaseline = members.some((member) => member.accounts.some((account) =>
      !session.accounts.get(account.puuid)?.baselined && (this.dependencies.mock() || !account.puuid.startsWith("MOCK-"))));
    if (joined.length > 0 || needsBaseline) this.pollSoon(client, guildId, session);
  }

  /**
   * Start tracking present members' accounts the session has not seen.
   * `since` is passed for accounts joining a running session: the member's join time, or later for an account added afterwards.
   */
  private track(session: MonitorSession, members: TrackedMember[], since?: number): void {
    for (const member of members) {
      if (!session.present.has(member.discordUserId)) continue;
      for (const account of member.accounts) {
        if (session.accounts.has(account.puuid)) continue;
        session.accounts.set(account.puuid, { owner: member.discordUserId, since, baselined: false });
      }
    }
  }

  stop(guildId: string, reason = "monitoring was stopped"): void {
    const session = this.sessions.get(guildId);
    session?.controller.abort(new AnnouncementCancelledError());
    this.sessions.delete(guildId);
    resetAnnouncerRuntime(guildId);
    if (session) this.dependencies.info(`Monitoring stopped: ${reason}.`);
  }

  stopAll(): void {
    for (const guildId of this.sessions.keys()) this.stop(guildId, "the bot is shutting down");
  }

  status(guildId: string): MonitorStatus {
    const session = this.sessions.get(guildId);
    return {
      active: Boolean(session),
      startedAt: session?.startedAt,
      lastPollAt: session?.lastPollAt,
      lastError: this.lastErrors.get(guildId),
      announced: new Set(session?.announced),
      presentMemberIds: [...(session?.present.keys() ?? [])],
    };
  }

  poll(client: Client, guildId: string, requiredVoiceChannelId?: string): Promise<PollResult> {
    const session = this.sessions.get(guildId);
    if (!session) return Promise.resolve({ announced: 0, errors: 0 });
    if (session.inFlight) {
      if (requiredVoiceChannelId) session.inFlightTargets?.add(requiredVoiceChannelId);
      return session.inFlight;
    }
    const targets = new Set(requiredVoiceChannelId ? [requiredVoiceChannelId] : []);
    session.inFlightTargets = targets;
    const poll = this.run(client, guildId, session, targets).finally(() => {
      if (session.inFlight !== poll) return;
      session.inFlight = undefined;
      session.inFlightTargets = undefined;
      if (session.pollAgain && this.current(guildId, session)) {
        session.pollAgain = false;
        void this.poll(client, guildId);
      }
    });
    session.inFlight = poll;
    return poll;
  }

  private describe(client: Client, guildId: string, member: TrackedMember): string {
    const channel = this.dependencies.resolveChannel(client, guildId, member.discordUserId);
    const where = channel ? `voice channel ${(channel as { name?: string }).name ?? channel.id}` : "a voice channel announcements cannot use";
    return `${riotIds(member.accounts)} in ${where}`;
  }

  /** Poll now, or right after the running poll, which may have started before this member's accounts were known. */
  private pollSoon(client: Client, guildId: string, session: MonitorSession): void {
    if (session.inFlight) session.pollAgain = true;
    else void this.poll(client, guildId);
  }

  /**
   * Drop baselines whose account is no longer owned by a present member: someone left, was unbound, or replaced an account.
   * A dropped account gets a fresh baseline if it comes back, so a match it finished meanwhile is never replayed.
   */
  private prune(guildId: string, session: MonitorSession, members = this.dependencies.members(guildId)): void {
    const owners = new Map<string, string>();
    for (const member of members) {
      if (!session.present.has(member.discordUserId)) continue;
      for (const account of member.accounts) owners.set(account.puuid, member.discordUserId);
    }
    const dropped = [...session.accounts].filter(([puuid, state]) => owners.get(puuid) !== state.owner).map(([puuid]) => puuid);
    for (const puuid of dropped) session.accounts.delete(puuid);
    clearLastMatchIds(guildId, dropped);
    for (const [matchId, waiting] of session.waiting) {
      for (const puuid of dropped) waiting.reporters.delete(puuid);
      if (waiting.reporters.size === 0) session.waiting.delete(matchId);
    }
  }

  private report(guildId: string, error: unknown): void {
    this.lastErrors.set(guildId, { message: errorMessage(error), at: Date.now() });
    this.dependencies.log(error);
  }

  private current(guildId: string, session: MonitorSession): boolean {
    return this.sessions.get(guildId) === session && !session.controller.signal.aborted;
  }

  private ownerOf(guildId: string, puuid: string): string | undefined {
    return this.dependencies.members(guildId).find((member) => member.accounts.some((account) => account.puuid === puuid))?.discordUserId;
  }

  /**
   * The channel with the most participating tracked members.
   * Ties keep the previous pick, then go to the channel with more people, then the earliest-bound member's channel, then the lower ID.
   */
  private chooseChannel(client: Client, guildId: string, participatingMemberIds: string[], previousId?: string): VoiceChannel | null {
    const tallies = new Map<string, { channel: VoiceChannel; members: number; order: number }>();
    participatingMemberIds.forEach((memberId, order) => {
      const channel = this.dependencies.resolveChannel(client, guildId, memberId);
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

  private boundParticipants(guildId: string, detail: MatchDetail): BoundParticipant[] {
    const result: BoundParticipant[] = [];
    for (const member of this.dependencies.members(guildId)) {
      for (const account of member.accounts) {
        const participant = detail.info.participants.find((player) => player.puuid === account.puuid);
        if (participant && !result.some((entry) => entry.puuid === participant.puuid)) {
          result.push({ memberId: member.discordUserId, puuid: participant.puuid, teamId: participant.teamId });
        }
      }
    }
    return result;
  }

  /**
   * Tracked players of the match who still own the account they played on, in bind order.
   * Read live, so someone unbound during the report neither counts for the channel nor gets mentioned.
   */
  private liveParticipantIds(guildId: string, participants: BoundParticipant[]): string[] {
    const members = this.dependencies.members(guildId);
    const owns = (participant: BoundParticipant) => members.some((member) =>
      member.discordUserId === participant.memberId && member.accounts.some((account) => account.puuid === participant.puuid));
    return [...new Set(participants.filter(owns).map((participant) => participant.memberId))];
  }

  /**
   * The team with the most participating members in the channel, then the earliest-bound member's team; that team's earliest-bound member speaks.
   * Members the session covers are preferred, since the speaker must still be in voice when playback starts.
   */
  private perspective(client: Client, guildId: string, session: MonitorSession, participants: BoundParticipant[], channel: VoiceChannel): BoundParticipant | undefined {
    const inChannel = participants.filter((participant) =>
      this.dependencies.resolveChannel(client, guildId, participant.memberId)?.id === channel.id);
    const present = inChannel.filter((participant) => session.present.has(participant.memberId));
    const pool = present.length > 0 ? present : inChannel.length > 0 ? inChannel : participants;
    const teamSize = (teamId: number) => pool.filter((participant) => participant.teamId === teamId).length;
    const largest = Math.max(...pool.map((participant) => teamSize(participant.teamId)));
    return pool.find((participant) => teamSize(participant.teamId) === largest);
  }

  /** Whether an account is still the one this lookup started for, after an await: same session, same owner, owner still present. */
  private stillTracked(guildId: string, session: MonitorSession, puuid: string, state: AccountState): boolean {
    return this.current(guildId, session) && session.accounts.get(puuid) === state && session.present.has(state.owner);
  }

  private async run(client: Client, guildId: string, session: MonitorSession, requiredTargets: Set<string>): Promise<PollResult> {
    const result = { announced: 0, errors: 0 };
    const fail = (error: unknown): boolean => {
      result.errors++;
      this.report(guildId, error);
      if (!isCredentialFailure(error)) return false;
      // Credential/configuration failures need a deliberate restart, not a timer retry loop.
      this.stop(guildId, "Riot rejected the credentials or configuration; fix .env and restart the bot");
      return true;
    };
    try {
      if (!this.current(guildId, session)) return result;
      const members = this.dependencies.members(guildId);
      this.prune(guildId, session, members);
      // Accounts changed without a sync (for example a rebind) still count from now.
      this.track(session, members, Date.now());
      const accounts: RiotAccount[] = [];
      const seen = new Set<string>();
      for (const member of members) {
        if (!session.present.has(member.discordUserId)) continue;
        for (const account of member.accounts) {
          if (seen.has(account.puuid)) continue;
          seen.add(account.puuid);
          accounts.push(account);
        }
      }

      // Phase A: each present account's latest match becomes a baseline or joins the pending match it reports.
      const pending = new Map<string, PendingMatch>();
      const addPending = (matchId: string, account: RiotAccount, detail?: MatchDetail) => {
        const match = pending.get(matchId) ?? { matchId, reporters: [] };
        match.reporters.push(account);
        match.detail ??= detail;
        pending.set(matchId, match);
      };
      for (const account of accounts) {
        if (!this.current(guildId, session)) return result;
        if (!this.dependencies.mock() && account.puuid.startsWith("MOCK-")) {
          if (!session.skippedMockAccounts.has(account.puuid)) {
            session.skippedMockAccounts.add(account.puuid);
            result.errors++;
            this.report(guildId, new Error(`The mock account ${account.gameName}#${account.tagLine} was skipped in real mode. `
              + "Use /bind with a real Riot ID to replace it."));
          }
          continue;
        }
        const state = session.accounts.get(account.puuid);
        if (!state) continue;
        let matchId: string | null;
        try {
          matchId = await this.dependencies.latest(account.puuid);
        } catch (error) {
          if (!this.current(guildId, session)) return result;
          if (fail(error)) return result;
          continue;
        }
        if (!this.current(guildId, session)) return result;
        // The member may have left, rejoined or been unbound while Riot answered.
        if (!this.stillTracked(guildId, session, account.puuid, state) || this.ownerOf(guildId, account.puuid) !== state.owner) continue;
        if (!state.baselined) {
          if (matchId && state.since !== undefined && !session.announced.has(matchId)) {
            // This lookup may have waited behind a long poll; a match that ended after the account joined is new, not history.
            let detail: MatchDetail;
            try {
              detail = session.waiting.get(matchId)?.detail ?? await this.dependencies.detail(matchId);
            } catch (error) {
              if (!this.current(guildId, session)) return result;
              if (fail(error)) return result;
              continue;
            }
            if (!this.stillTracked(guildId, session, account.puuid, state)) continue;
            const ended = detail.info.gameEndTimestamp;
            if (ended !== null && ended > state.since) {
              state.baselined = true;
              this.dependencies.info(`Baseline for ${account.gameName}#${account.tagLine}: none; ${matchId} ended after they joined, `
                + "so it is announced.");
              addPending(matchId, account, detail);
              continue;
            }
          }
          // null is a valid baseline for an account with no SR match history.
          state.baselined = true;
          if (matchId) setLastMatchId(guildId, account.puuid, matchId);
          this.dependencies.info(`Baseline for ${account.gameName}#${account.tagLine}: ${matchId ?? "no Summoner's Rift history"}; `
            + "only matches that finish after this are announced.");
          continue;
        }
        if (!matchId || matchId === getLastMatchId(guildId, account.puuid)) continue;
        if (session.announced.has(matchId)) {
          setLastMatchId(guildId, account.puuid, matchId);
          continue;
        }
        addPending(matchId, account);
      }

      // Phase B: fetch each pending match once, then announce the oldest first.
      // A match still waiting for a usable channel reuses its detail and is not logged again.
      const ready: PendingMatch[] = [];
      for (const match of pending.values()) {
        const waiting = session.waiting.get(match.matchId);
        if (waiting) {
          match.detail = waiting.detail;
          match.detectedAt = waiting.detectedAt;
          for (const account of match.reporters) waiting.reporters.add(account.puuid);
          ready.push(match);
          continue;
        }
        if (!match.detail) {
          try {
            match.detail = await this.dependencies.detail(match.matchId);
          } catch (error) {
            if (!this.current(guildId, session)) return result;
            if (fail(error)) return result;
            continue;
          }
          if (!this.current(guildId, session)) return result;
        }
        match.detectedAt = Date.now();
        const ended = match.detail.info.gameEndTimestamp === null
          ? "end time unknown" : `ended ${Math.round((match.detectedAt - match.detail.info.gameEndTimestamp) / 1000)} s ago`;
        this.dependencies.info(`Detected finished match ${match.matchId} for ${riotIds(match.reporters)}: ${ended}, `
          + `queue ${match.detail.info.queueId}, ${Math.round(match.detail.info.gameDuration / 60)} min.`);
        ready.push(match);
      }
      ready.sort(byGameEnd);

      // Phase C: announce one at a time through the guild's voice queue.
      for (const match of ready) {
        if (!this.current(guildId, session)) return result;
        try {
          if (await this.announce(client, guildId, session, match, requiredTargets, result)) result.announced++;
        } catch (error) {
          if (error instanceof AnnouncementCancelledError || !this.current(guildId, session)) continue;
          if (fail(error)) return result;
        }
      }
    } catch (error) {
      result.errors++;
      this.report(guildId, error);
    } finally {
      session.lastPollAt = Date.now();
      if (result.errors === 0) this.lastErrors.delete(guildId);
    }
    return result;
  }

  /** Speak one match and post its report. Returns false when no participant is in an allowed channel yet. */
  private async announce(
    client: Client,
    guildId: string,
    session: MonitorSession,
    match: PendingMatch,
    requiredTargets: Set<string>,
    result: PollResult,
  ): Promise<boolean> {
    const detail = match.detail!;
    const boundParticipants = this.boundParticipants(guildId, detail);
    const initial = this.chooseChannel(client, guildId, this.liveParticipantIds(guildId, boundParticipants), session.lastChannelId);
    if (!initial) {
      // Not an error: the match waits, unconsumed, until a participant is in an allowed channel or its accounts stop being tracked.
      if (!session.waiting.has(match.matchId)) {
        session.waiting.set(match.matchId, {
          detail, detectedAt: match.detectedAt!, reporters: new Set(match.reporters.map((account) => account.puuid)),
        });
        if (session.waiting.size > WAITING_LIMIT) session.waiting.delete(session.waiting.keys().next().value!);
        this.dependencies.info(`Match ${match.matchId} is waiting: no tracked player of it is in a voice channel announcements can use.`);
      }
      return false;
    }
    // A failure from here on is retried through the normal path, which fetches the match again.
    session.waiting.delete(match.matchId);
    const detected: DetectedMatch = { matchId: match.matchId, detail, boundParticipants, channelId: initial.id };
    // The speaker is fixed with the text; a later majority move changes only where it plays.
    const speaker = this.perspective(client, guildId, session, detected.boundParticipants, initial)!;
    const { speech: text, report } = buildMatchAnnouncement(detail, speaker.puuid, this.dependencies.mock());
    let pick = initial.id;
    const resolveTarget = () => {
      const chosen = this.chooseChannel(client, guildId, this.liveParticipantIds(guildId, boundParticipants), pick);
      if (!chosen) return null;
      pick = chosen.id;
      session.lastChannelId = chosen.id;
      if ([...requiredTargets].some((id) => chosen.id !== id)) return null;
      return chosen;
    };
    // The queue resolves the channel once before generation and once right before joining, after the first two chunks;
    // from the second call on the report is playing. tests/monitor.test.ts pins this through the real queue.
    let queueResolves = 0;
    let playing = false;
    const resolveForQueue = () => {
      const target = resolveTarget();
      if (++queueResolves >= 2 && target) playing = true;
      return target;
    };
    // Rebinding or unbinding the speaker always cancels; an unrelated bind does not.
    // The speaker must still be in voice before generation and before joining, but once playing, a speaker who leaves
    // does not cut off teammates who stay: only the channel choice can stop it then.
    const canPlay = () => this.current(guildId, session)
      && this.ownerOf(guildId, speaker.puuid) === speaker.memberId
      && (playing || session.present.has(speaker.memberId))
      && Boolean(resolveTarget());
    const channel = await this.dependencies.announce(
      guildId,
      text,
      getAnnouncerState(guildId).voiceStyle,
      resolveForQueue,
      canPlay,
      session.controller.signal,
    );
    if (!this.current(guildId, session)) throw new AnnouncementCancelledError();
    // Failed TTS/transport throws before this point and leaves every baseline untouched so the next poll retries.
    session.announced.add(match.matchId);
    if (session.announced.size > 200) session.announced.delete(session.announced.values().next().value!);
    for (const account of match.reporters) {
      if (session.accounts.get(account.puuid)?.baselined) setLastMatchId(guildId, account.puuid, match.matchId);
    }
    this.dependencies.info(`Announced match ${match.matchId} in voice ${Math.round((Date.now() - match.detectedAt!) / 1000)} s after detection.`);
    const mentions = this.liveParticipantIds(guildId, boundParticipants).filter((memberId) => channel.members.has(memberId));
    try {
      await channel.send({
        ...(mentions.length > 0 ? { content: mentions.map((memberId) => `<@${memberId}>`).join(" ") } : {}),
        embeds: [buildHorseReportEmbed(report)],
        allowedMentions: { parse: [], roles: [], users: mentions, repliedUser: false },
      });
    } catch (error) {
      // Audio has already succeeded; retrying the match would repeat the voice announcement.
      result.errors++;
      this.report(guildId, error);
    }
    return true;
  }
}

export function resolveMonitoredVoiceChannel(client: Client, guildId: string, userId: string): VoiceChannel | null {
  const channel = client.guilds.cache.get(guildId)?.members.cache.get(userId)?.voice.channel;
  if (!(channel instanceof VoiceChannel)) return null;
  if (getRiotMode() === "mock") {
    const testGuildId = process.env.TEST_GUILD_ID?.trim();
    const testChannelId = process.env.TEST_VOICE_CHANNEL_ID?.trim();
    if ((testGuildId && guildId !== testGuildId) || (testChannelId && channel.id !== testChannelId)) return null;
  }
  return channel;
}

const monitor = new GameMonitor({
  latest: getLatestSRMatchId,
  detail: getMatchDetail,
  members: listTrackedMembers,
  resolveChannel: resolveMonitoredVoiceChannel,
  announce: announceTextToCurrentChannel,
  mock: () => getRiotMode() === "mock",
  log: (error) => logError(`Match monitoring failed: ${errorMessage(error)}`),
  info: logInfo,
});

/** Point the guild's session at the tracked members who are in voice now; an empty list stops it. */
export function syncMonitoring(client: Client, guildId: string, presentMemberIds: Iterable<string>): void {
  monitor.sync(client, guildId, presentMemberIds);
}

export function stopPolling(guildId: string, reason?: string): void {
  monitor.stop(guildId, reason);
}

export function getMonitorStatus(guildId: string): MonitorStatus {
  return monitor.status(guildId);
}

export function pollGuildNow(client: Client, guildId: string, requiredVoiceChannelId?: string): Promise<PollResult> {
  return monitor.poll(client, guildId, requiredVoiceChannelId);
}

export function stopAllPolling(): void {
  monitor.stopAll();
}
