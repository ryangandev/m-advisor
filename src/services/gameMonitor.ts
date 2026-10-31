import { Client, VoiceChannel } from "discord.js";
import { PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";
import type { Message, MessageCreateOptions } from "discord.js";
import type { MatchDetail, RiotAccount, TrackedMember } from "../types";
import { listTrackedMembers } from "../store/bindingStore";
import {
  clearLastMatchIds,
  getAnnouncerState,
  getLastMatchId,
  resetAnnouncerRuntime,
  setLastMatchId,
  getPregameVoiceEnabled,
  setPollingInterval,
} from "../store/announcerStore";
import { getLatestSRMatchId, getMatchDetail } from "../utils/riotMatchApi";
import { getRiotMode, RiotApiError } from "./riotData";
import { buildMatchAnnouncement } from "./announcementText";
import { buildPregameRecap } from "./pregameRecap";
import type { MatchAnnouncement } from "./announcementText";
import { fetchMatchEvents } from "./matchEvents";
import type { MatchEvent } from "./matchEvents";
import { buildHorseRecords } from "./horseRecords";
import { listHorseRecords, recordHorseRecords } from "../store/horseRecordStore";
import { recordRankResults } from "../store/rankStore";
import type { RankResult } from "../store/rankStore";
import type { HorseRecord } from "../store/horseRecordStore";
import { buildHorseReportEmbed, buildPartyEmbed, buildRankAnnouncementEmbed, NO_MENTIONS } from "../utils/embeds";
import { AnnouncementCancelledError, AnnouncementQueueFullError, announceTextToCurrentChannel } from "./voiceAnnouncements";
import { logError, logInfo } from "../utils/log";
import { boundParticipants, chooseChannel, isUsableVoiceChannel, liveParticipantIds, liveParticipants, perspective } from "./channelChoice";
import type { BoundParticipant } from "./channelChoice";
import { createGameStartMemory, GameStartWatcher, recallPick } from "./gameStartWatcher";
import type { GameStartDependencies, GameStartMemory, GameStartOutcome, GameStartTickResult } from "./gameStartWatcher";
import { getActiveGame } from "../utils/riotSpectatorApi";
import { getLeagueEntries } from "../utils/riotLeagueApi";
import { rankedQueueFor } from "./rankMath";
import { buildRankResult } from "./rankResults";
import { RankTracker } from "./rankTracker";
import type { RankTracking } from "./rankTracker";
import { buildRankVoiceLine, rankMoveOf, rankMoveText, rankRowText } from "./rankText";
import type { RankMove, RankVoiceMove } from "./rankText";

/** What the game start watcher needs beyond what the match monitor already has. */
export type GameStartWatcherInputs = Pick<GameStartDependencies, "activeGame" | "records" | "pregameVoice" | "voiceStyle" | "now"> & {
  /** Where the watcher logs its errors; the monitor's own `log` when absent. */
  log?: (error: unknown) => void;
};

export const POLL_INTERVAL_MS = 45_000;
/** After this many failed voice attempts a match is consumed without voice; its text report was already posted. */
export const MAX_VOICE_ATTEMPTS = 3;
/** How long the baselines of accounts whose member left voice are kept, so a quick return does not lose the match just finished. */
export const KEEP_BASELINES_MS = 120_000;
/**
 * A baseline is kept only if its account was read this recently when the member left, so a Mac that slept for hours
 * and then reconciles cannot bring back a stale baseline and replay an old match. A poll in flight, whose report may take
 * minutes to speak, allows the longer age, and so does one that finished within this time for the accounts it read.
 */
export const KEEP_FRESH_MS = 2 * POLL_INTERVAL_MS;
const KEEP_FRESH_BUSY_MS = 10 * 60_000;
/**
 * How long a guild remembers a match whose text it posted or that it consumed: the longest a kept baseline can be
 * restored after its account's last read. Any baseline restored within that time sees every match handled since the read.
 */
export const HANDLED_MS = KEEP_FRESH_BUSY_MS + KEEP_BASELINES_MS;
/** At most this many handled matches are remembered per guild; the oldest is forgotten first. */
const HANDLED_LIMIT = 50;
/** The monitor's own limit on the timeline, above its request timeout, so a stuck timeline never holds a report. */
const TIMELINE_WAIT_MS = 8_000;
/**
 * How long a session that resumes a match waits for another session's text send to settle. Discord requests time out
 * and retry well within it; past it the post is unknown, and the session speaks without posting the text again.
 */
export const IN_FLIGHT_WAIT_MS = 120_000;
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
  /**
   * A member's current voice channel if text may be posted there, even when the bot cannot join or speak in it (full, AFK, no
   * Connect or Speak). Without it a match waits for a channel the voice can use.
   */
  resolveTextChannel?: (client: Client, guildId: string, userId: string) => VoiceChannel | null;
  announce: typeof announceTextToCurrentChannel;
  /** Timeline moments for the praise and roast; null when the timeline is unavailable. */
  events: (matchId: string, detail: MatchDetail) => Promise<readonly MatchEvent[] | null>;
  /** Saves 马厩 records and returns how many were new; see recordHorseRecords. */
  record: (records: readonly HorseRecord[]) => number;
  /** How long a report waits for its timeline; TIMELINE_WAIT_MS by default. */
  timelineWaitMs?: number;
  /** How long a resuming session waits for another session's text send; IN_FLIGHT_WAIT_MS by default. */
  inFlightWaitMs?: number;
  /**
   * Riot spectator, 马厩 records and the pregame settings for the game start watcher (军师赛前锦囊).
   * Without it a session watches finished matches only.
   */
  gameStart?: GameStartWatcherInputs;
  /**
   * Rank snapshots around ranked games for the 段位变化 field: one process-wide tracker shared by every guild.
   * Without it reports have no 段位变化 field.
   */
  rank?: RankTracking;
  /**
   * Saves the final LP results of a report's members and returns how many were new; see recordRankResults.
   * Without it nothing is stored. A failure is logged and never reaches the report.
   */
  recordRank?: (results: readonly RankResult[]) => number;
  mock: () => boolean;
  log: (error: unknown) => void;
  /** Progress messages for the operator, such as a newly detected match. */
  info: (message: string) => void;
}

export type { BoundParticipant } from "./channelChoice";

/** A bound member on the reported team and the account they played on: one 段位变化 row at most. */
interface RankMember {
  memberId: string;
  puuid: string;
}

/**
 * The 段位播报 of one match: a separate message, and a short voice line after the report's own voice.
 * It outlives the match's progress entry, so a late update can still send it after the report was consumed.
 */
interface RankCast {
  matchId: string;
  client: Client;
  guildId: string;
  session: MonitorSession;
  /** Where the report text was posted, and where the messages go; refreshed when the report text actually posts. */
  channel: VoiceChannel;
  detail: MatchDetail;
  /** The reported team's bound members, refreshed with the channel. */
  party: readonly RankMember[];
  /** The poll's channel guard, copied: a /simulate poll pins the authorized channel. */
  requiredTargets: ReadonlySet<string>;
  /** Members already announced in this match: nobody is announced twice. */
  announced: Set<string>;
  /** Voice lines waiting for the report's voice, flushed in order once it has finished. */
  pendingLines: string[];
  /**
   * The report's own voice: a line is queued only when it is `done`; `given_up` (the report's voice hit its attempt cap)
   * and `dropped` (the report's text never posted) leave every line text only.
   */
  reportVoice: "pending" | "done" | "given_up" | "dropped";
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
  /** When the account's latest match was last read successfully. */
  readAt?: number;
  /** Its member was bound or unbound since the session saw it, so its baseline is not kept when they leave. */
  noKeep?: boolean;
}

/** The baseline of an account whose member left voice: the latest match it had consumed, or none for a valid empty history. */
interface KeptBaseline {
  owner: string;
  matchId: string | undefined;
  keptAt: number;
  /** When the account was last really read, carried over so leaving and returning again never extends its freshness. */
  readAt: number;
}

/**
 * A match this guild posted the text of, is posting it, or consumed, whichever session did it and whoever has left since.
 * Every session of the guild treats it as announced, or carries its report on, for HANDLED_MS.
 */
interface HandledMatch {
  /** The match's progress: the same object a session works on, so its voice failures and 段位播报 carry over. */
  progress: MatchProgress;
  /** Announced, given up or posted as text only: never announced again. Otherwise only its text is out, or on its way. */
  consumed: boolean;
  /** When it was last handled, or last held by a session that let go of it. */
  at: number;
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

/**
 * A match the session has started to announce: it had a usable channel at least once.
 * Kept until the match is consumed, so a voice retry on a later poll reuses the detail and timeline,
 * never posts the text report again and counts toward the attempt cap.
 */
interface MatchProgress {
  detail: MatchDetail;
  detectedAt: number;
  /** Accounts that reported it; the entry is dropped once none of them is tracked any more. */
  reporters: Set<string>;
  /** Timeline moments, fetched once; null when unavailable, undefined until fetched. */
  events?: readonly MatchEvent[] | null;
  /** The account whose perspective the report takes; kept for retries while its owner can still hear it. */
  speakerPuuid?: string;
  /** The text report was posted, and the 马厩 records were written with it. */
  textPosted: boolean;
  /**
   * The text post Discord has not answered yet; it settles, never rejecting, once `textPosted` says how it went.
   * A session that resumes the report meanwhile waits for it instead of posting again.
   */
  posting?: Promise<void>;
  /**
   * A session stopped waiting for `posting` because Discord had not answered in IN_FLIGHT_WAIT_MS: the text may or may not
   * be out, so it is not posted again and the voice goes on. Cleared if that send fails after all.
   */
  postUnknown?: boolean;
  /** The posted report, kept so a late 段位变化 can edit it once. */
  reportMessage?: Message;
  /** The match's 段位播报, kept across voice retries so it is sent once. */
  rankCast?: RankCast;
  /**
   * Attempts that failed once the match had a channel, whether building the report or speaking it.
   * Cancellations and a full voice queue do not count.
   */
  voiceFailures: number;
}

/** At most this many started matches are remembered per session; the oldest is forgotten first. */
const PROGRESS_LIMIT = 50;

interface MonitorSession {
  startedAt: number;
  /** When the running poll started, or the last one when none runs. */
  lastPollStartedAt?: number;
  lastPollAt?: number;
  controller: AbortController;
  /** Tracked members in voice, in bind order. */
  present: Map<string, PresentMember>;
  /** Accounts of present members that this session has seen. */
  accounts: Map<string, AccountState>;
  announced: Set<string>;
  skippedMockAccounts: Set<string>;
  waiting: Map<string, WaitingMatch>;
  progress: Map<string, MatchProgress>;
  /** The channel of the latest announcement, kept so ties do not bounce between channels. */
  lastChannelId?: string;
  inFlight?: Promise<PollResult>;
  inFlightTargets?: Set<string>;
  /** Someone joined or gained an account while a poll was running, so poll again right after it. */
  pollAgain?: boolean;
  /** Watches for games on their loading screen with its own timer; absent without spectator dependencies. */
  watcher?: GameStartWatcher;
}

function riotIds(accounts: RiotAccount[]): string {
  return accounts.map((account) => `${account.gameName}#${account.tagLine}`).join(", ");
}

function secondsSince(start: number): string {
  return ((Date.now() - start) / 1000).toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isCredentialFailure(error: unknown): boolean {
  return error instanceof RiotApiError && ["missing_key", "unauthorized", "forbidden", "invalid_mode"].includes(error.code);
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
  /** Each guild's game start memory, kept across sessions so leaving and rejoining voice never repeats a 锦囊. */
  private readonly gameStartMemory = new Map<string, GameStartMemory>();
  /** stopAll ran: the bot is shutting down. */
  private closed = false;
  /** Each guild's baselines of accounts whose member left voice, for KEEP_BASELINES_MS; see keepBaselines. */
  private readonly kept = new Map<string, Map<string, KeptBaseline>>();
  /** Each guild's recently handled matches, for HANDLED_MS; see remember. */
  private readonly handled = new Map<string, Map<string, HandledMatch>>();

  constructor(private readonly dependencies: MonitorDependencies) {}

  /**
   * Match the session to the tracked members who are in voice now.
   * No one present stops it; the first member starts it; a joining member gets a fresh baseline; a leaving member's baselines are dropped.
   * Channel moves do not touch the session.
   */
  sync(client: Client, guildId: string, presentMemberIds: Iterable<string>): void {
    const wanted = new Set(presentMemberIds);
    this.purge(guildId);
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
        progress: new Map(),
      };
      this.track(guildId, session, members);
      this.sessions.set(guildId, session);
      session.watcher = this.createWatcher(client, guildId, session);
      this.dependencies.info(`Monitoring started for ${members.map((member) => this.describe(client, guildId, member)).join("; ")}; `
        + `checking every ${POLL_INTERVAL_MS / 1000} s.`);
      const interval = setInterval(() => { void this.poll(client, guildId); }, POLL_INTERVAL_MS);
      interval.unref();
      setPollingInterval(guildId, interval);
      void this.poll(client, guildId);
      session.watcher?.start();
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
    this.track(guildId, session, members, now);
    session.watcher?.sync(members);
    const needsBaseline = members.some((member) => member.accounts.some((account) =>
      !session.accounts.get(account.puuid)?.baselined && (this.dependencies.mock() || !account.puuid.startsWith("MOCK-"))));
    if (joined.length > 0 || needsBaseline) this.pollSoon(client, guildId, session);
  }

  /**
   * Start tracking present members' accounts the session has not seen.
   * `since` is passed for accounts joining a running session: the member's join time, or later for an account added afterwards.
   */
  private track(guildId: string, session: MonitorSession, members: TrackedMember[], since?: number): void {
    for (const member of members) {
      if (!session.present.has(member.discordUserId)) continue;
      for (const account of member.accounts) {
        if (session.accounts.has(account.puuid)) continue;
        const kept = this.takeKeptBaseline(guildId, account.puuid, member.discordUserId);
        if (kept) {
          // The same member is back within the window: the match they finished meanwhile is detected like any later one.
          if (kept.matchId) setLastMatchId(guildId, account.puuid, kept.matchId);
          session.accounts.set(account.puuid, { owner: member.discordUserId, since, baselined: true, readAt: kept.readAt });
          this.dependencies.info(`Baseline for ${account.gameName}#${account.tagLine} kept from before they left voice: `
            + `${kept.matchId ?? "no Summoner's Rift history"}.`);
          continue;
        }
        session.accounts.set(account.puuid, { owner: member.discordUserId, since, baselined: false });
      }
    }
  }

  /**
   * Forgets expired kept baselines and handled matches, and the baselines of accounts that no longer belong to the
   * member who left with them.
   */
  private purge(guildId: string): void {
    const now = Date.now();
    const kept = this.kept.get(guildId);
    if (kept) {
      for (const [puuid, entry] of kept) {
        if (now - entry.keptAt > KEEP_BASELINES_MS || this.ownerOf(guildId, puuid) !== entry.owner) kept.delete(puuid);
      }
      if (kept.size === 0) this.kept.delete(guildId);
    }
    const handled = this.handled.get(guildId);
    if (handled) {
      for (const [matchId, entry] of handled) if (now - entry.at > HANDLED_MS) handled.delete(matchId);
      if (handled.size === 0) this.handled.delete(guildId);
    }
  }

  /**
   * Remember the baselines of accounts whose member left voice but still owns them, for KEEP_BASELINES_MS.
   * An unbound or rebound member, a moved account, an account not read recently and the shutdown keep nothing.
   */
  private keepBaselines(guildId: string, session: MonitorSession, accounts: Iterable<[string, AccountState]>): void {
    if (this.closed) return;
    this.purge(guildId);
    const now = Date.now();
    // A poll reads its accounts before it speaks, so right after a long report every read is old although the session
    // was busy all along; the longer age holds until the next tick could have read them again, but only for accounts
    // that poll really read, so a poll whose reads failed, as right after the Mac woke, extends nothing.
    const justPolled = session.inFlight === undefined && session.lastPollAt !== undefined
      && session.lastPollStartedAt !== undefined && now - session.lastPollAt <= KEEP_FRESH_MS;
    const kept = this.kept.get(guildId) ?? new Map<string, KeptBaseline>();
    for (const [puuid, state] of accounts) {
      if (!state.baselined || state.noKeep || this.ownerOf(guildId, puuid) !== state.owner) continue;
      if (state.readAt === undefined) continue;
      const busy = session.inFlight !== undefined || (justPolled && state.readAt >= session.lastPollStartedAt!);
      if (now - state.readAt > (busy ? KEEP_FRESH_BUSY_MS : KEEP_FRESH_MS)) continue;
      kept.set(puuid, { owner: state.owner, matchId: getLastMatchId(guildId, puuid), keptAt: now, readAt: state.readAt });
    }
    if (kept.size > 0) this.kept.set(guildId, kept);
  }

  /** The kept baseline of an account, if its same member returned within the window; it is used up either way. */
  private takeKeptBaseline(guildId: string, puuid: string, owner: string): KeptBaseline | undefined {
    this.purge(guildId);
    const kept = this.kept.get(guildId);
    const entry = kept?.get(puuid);
    if (!kept || !entry) return undefined;
    kept.delete(puuid);
    if (kept.size === 0) this.kept.delete(guildId);
    return entry.owner === owner ? entry : undefined;
  }

  /**
   * A member was bound or unbound: none of their baselines from before is kept or restored, so an unbind and a rebind
   * that race a queued reconciliation still start fresh.
   */
  forgetMember(guildId: string, memberId: string): void {
    const kept = this.kept.get(guildId);
    if (kept) {
      for (const [puuid, entry] of kept) if (entry.owner === memberId) kept.delete(puuid);
      if (kept.size === 0) this.kept.delete(guildId);
    }
    for (const state of this.sessions.get(guildId)?.accounts.values() ?? []) {
      if (state.owner === memberId) state.noKeep = true;
    }
  }

  /**
   * Notes a match whose text is being posted, was posted or that was consumed, or refreshes one a session lets go of,
   * for HANDLED_MS. It is written whether or not anyone's baseline is kept, so no session of the guild posts or announces
   * it again.
   */
  private remember(guildId: string, matchId: string, progress: MatchProgress, consumed = false): void {
    const handled = this.handled.get(guildId) ?? new Map<string, HandledMatch>();
    const previous = handled.get(matchId);
    handled.delete(matchId);
    handled.set(matchId, { progress, consumed: consumed || Boolean(previous?.consumed), at: Date.now() });
    if (handled.size > HANDLED_LIMIT) handled.delete(handled.keys().next().value!);
    this.handled.set(guildId, handled);
  }

  /** A post of this progress failed: the guild no longer remembers it, so whichever session sees the match next posts it. */
  private forgetPost(guildId: string, matchId: string, progress: MatchProgress): void {
    const handled = this.handled.get(guildId);
    const entry = handled?.get(matchId);
    if (!handled || entry?.progress !== progress || entry.consumed) return;
    handled.delete(matchId);
    if (handled.size === 0) this.handled.delete(guildId);
  }

  /** The guild's record of a recently handled match, if any. */
  private handledMatch(guildId: string, matchId: string): HandledMatch | undefined {
    const entry = this.handled.get(guildId)?.get(matchId);
    return entry && Date.now() - entry.at <= HANDLED_MS ? entry : undefined;
  }

  /** The match is done in this guild: this session announced it, or any session consumed it recently. */
  private isDone(guildId: string, session: MonitorSession, matchId: string): boolean {
    return session.announced.has(matchId) || Boolean(this.handledMatch(guildId, matchId)?.consumed);
  }

  /**
   * A report this guild posted, or is posting, but has not finished, from an earlier session or from before every account
   * reporting it left: this session carries it on, so its text is never posted again and its voice attempts keep counting.
   * Its 段位播报 follows this session, so the voice line is not dropped with the old one.
   */
  private resume(client: Client, guildId: string, session: MonitorSession, matchId: string): MatchProgress | undefined {
    const entry = this.handledMatch(guildId, matchId);
    if (!entry || entry.consumed) return undefined;
    const { progress } = entry;
    // Reporters belong to the session that saw them; this one adds its own.
    progress.reporters.clear();
    if (progress.rankCast) {
      progress.rankCast.session = session;
      progress.rankCast.client = client;
    }
    session.progress.set(matchId, progress);
    if (session.progress.size > PROGRESS_LIMIT) session.progress.delete(session.progress.keys().next().value!);
    return progress;
  }

  stop(guildId: string, reason = "monitoring was stopped"): void {
    const session = this.sessions.get(guildId);
    this.purge(guildId);
    session?.controller.abort(new AnnouncementCancelledError());
    session?.watcher?.stop();
    if (session) {
      this.keepBaselines(guildId, session, session.accounts);
      // A posted report, or one whose post is in flight, outlives the session for HANDLED_MS from now, so a return carries
      // it on.
      for (const [matchId, progress] of session.progress) {
        if (progress.textPosted || progress.posting) this.remember(guildId, matchId, progress);
      }
    }
    this.sessions.delete(guildId);
    resetAnnouncerRuntime(guildId);
    if (session) this.dependencies.info(`Monitoring stopped: ${reason}.`);
  }

  /** At shutdown: every session stops, and no late 段位变化 edit goes out on the closing client. */
  stopAll(): void {
    this.closed = true;
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

  /**
   * Check for games on their loading screen now, as /simulate does, and wait for the 锦囊 of `matchId` to settle.
   * A stopped guild, a session without a watcher or an unknown game returns null for the outcome.
   */
  async pollGameStart(guildId: string, matchId?: string, requiredVoiceChannelId?: string): Promise<{ tick: GameStartTickResult; outcome: GameStartOutcome | null }> {
    const watcher = this.sessions.get(guildId)?.watcher;
    if (!watcher) return { tick: { started: 0, posted: 0, errors: 0 }, outcome: null };
    const tick = await watcher.tick(requiredVoiceChannelId);
    return { tick, outcome: matchId ? await watcher.outcome(matchId) : null };
  }

  private gameStartMemoryOf(guildId: string): GameStartMemory {
    let memory = this.gameStartMemory.get(guildId);
    if (!memory) {
      memory = createGameStartMemory();
      this.gameStartMemory.set(guildId, memory);
    }
    return memory;
  }

  /** The session's game start watcher, sharing its members, channel choice, voice queue and abort signal. */
  private createWatcher(client: Client, guildId: string, session: MonitorSession): GameStartWatcher | undefined {
    const inputs = this.dependencies.gameStart;
    if (!inputs) return undefined;
    const { members, resolveChannel, resolveTextChannel, announce, mock, log, info } = this.dependencies;
    return new GameStartWatcher({
      client,
      guildId,
      signal: session.controller.signal,
      current: () => this.current(guildId, session),
      isPresent: (memberId) => session.present.has(memberId),
      // The game is over once its finished match is known: waiting for a channel, being announced or announced.
      finished: (matchId) => session.announced.has(matchId) || session.progress.has(matchId) || session.waiting.has(matchId)
        || Boolean(this.handledMatch(guildId, matchId)),
      lastChannelId: () => session.lastChannelId,
      rememberChannel: (channelId) => { session.lastChannelId = channelId; },
      memory: this.gameStartMemoryOf(guildId),
    }, { ...inputs, members, resolveChannel, resolveTextChannel, announce, mock, log: inputs.log ?? log, info, rank: this.dependencies.rank });
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
    session.watcher?.prune(members);
    const dropped = [...session.accounts].filter(([puuid, state]) => owners.get(puuid) !== state.owner).map(([puuid]) => puuid);
    this.keepBaselines(guildId, session, dropped.map((puuid) => [puuid, session.accounts.get(puuid)!] as [string, AccountState]));
    for (const puuid of dropped) session.accounts.delete(puuid);
    clearLastMatchIds(guildId, dropped);
    for (const [matchId, entry] of session.waiting) {
      for (const puuid of dropped) entry.reporters.delete(puuid);
      if (entry.reporters.size === 0) session.waiting.delete(matchId);
    }
    for (const [matchId, entry] of session.progress) {
      for (const puuid of dropped) entry.reporters.delete(puuid);
      if (entry.reporters.size > 0) continue;
      session.progress.delete(matchId);
      // A posted report, or one being posted, is not forgotten with its last reporter: whoever returns in time carries it on.
      if (entry.textPosted || entry.posting) this.remember(guildId, matchId, entry);
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

  private chooseChannel(client: Client, guildId: string, participatingMemberIds: string[], previousId?: string): VoiceChannel | null {
    return chooseChannel(this.dependencies.resolveChannel, client, guildId, participatingMemberIds, previousId);
  }

  private boundParticipants(guildId: string, detail: MatchDetail): BoundParticipant[] {
    return boundParticipants(this.dependencies.members(guildId), detail.info.participants);
  }

  /**
   * Tracked players of the match who still own the account they played on, in bind order.
   * Read live, so someone unbound during the report neither counts for the channel nor gets mentioned.
   */
  private liveParticipantIds(guildId: string, participants: BoundParticipant[]): string[] {
    return liveParticipantIds(this.dependencies.members(guildId), participants);
  }

  /** The participants who still own the account they played on, in bind order. */
  private liveParticipants(guildId: string, participants: BoundParticipant[]): BoundParticipant[] {
    return liveParticipants(this.dependencies.members(guildId), participants);
  }

  /** The channel text may go to when no player is in a channel the voice can use; see `resolveTextChannel`. */
  private chooseTextChannel(client: Client, guildId: string, participatingMemberIds: string[], previousId?: string): VoiceChannel | null {
    const resolve = this.dependencies.resolveTextChannel;
    return resolve ? chooseChannel(resolve, client, guildId, participatingMemberIds, previousId) : null;
  }

  /** See `perspective` in channelChoice: members the session covers are preferred. */
  private perspective(client: Client, guildId: string, session: MonitorSession, participants: BoundParticipant[], channel: VoiceChannel, textOnly = false): BoundParticipant | undefined {
    const resolve = (textOnly && this.dependencies.resolveTextChannel) || this.dependencies.resolveChannel;
    return perspective(resolve, client, guildId, (memberId) => session.present.has(memberId), participants, channel);
  }

  /** Whether an account is still the one this lookup started for, after an await: same session, same owner, owner still present. */
  private stillTracked(guildId: string, session: MonitorSession, puuid: string, state: AccountState): boolean {
    return this.current(guildId, session) && session.accounts.get(puuid) === state && session.present.has(state.owner);
  }

  private async run(client: Client, guildId: string, session: MonitorSession, requiredTargets: Set<string>): Promise<PollResult> {
    const result = { announced: 0, errors: 0 };
    session.lastPollStartedAt = Date.now();
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
      this.purge(guildId);
      this.prune(guildId, session, members);
      // Accounts changed without a sync (for example a rebind) still count from now.
      this.track(guildId, session, members, Date.now());
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
        state.readAt = Date.now();
        if (!state.baselined) {
          if (matchId && state.since !== undefined && !this.isDone(guildId, session, matchId)) {
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
          // The fallback before-value of the account's next ranked game, when no game start read replaces it.
          this.rankSnapshot(account.puuid);
          this.dependencies.info(`Baseline for ${account.gameName}#${account.tagLine}: ${matchId ?? "no Summoner's Rift history"}; `
            + "only matches that finish after this are announced.");
          continue;
        }
        if (!matchId || matchId === getLastMatchId(guildId, account.puuid)) continue;
        // Announced by this session, or by any session of the guild while this account was away or its list lagged.
        if (this.isDone(guildId, session, matchId)) {
          setLastMatchId(guildId, account.puuid, matchId);
          continue;
        }
        addPending(matchId, account);
      }

      // Phase B: fetch each pending match once, then announce the oldest first.
      // A match still waiting for a usable channel, or being retried, reuses its detail and is not logged again.
      // So does a report this guild already posted, whichever session posted it.
      const ready: PendingMatch[] = [];
      for (const match of pending.values()) {
        const known = session.waiting.get(match.matchId) ?? session.progress.get(match.matchId)
          ?? this.resume(client, guildId, session, match.matchId);
        if (known) {
          match.detail = known.detail;
          match.detectedAt = known.detectedAt;
          for (const account of match.reporters) known.reporters.add(account.puuid);
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
        this.rankFinished(guildId, match.matchId, match.detail);
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

  /**
   * Post one match's text report, then speak it. Returns false when no participant is in an allowed channel yet.
   * The text goes out once per match, before speech generation starts. A failed voice attempt leaves the match for the
   * next poll until MAX_VOICE_ATTEMPTS, after which it is consumed without voice.
   */
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
    const participantIds = () => this.liveParticipantIds(guildId, boundParticipants);
    let textOnly = false;
    const voiceChannel = this.chooseChannel(client, guildId, participantIds(), session.lastChannelId);
    if (!voiceChannel) {
      // Nobody is in a channel the voice can use: the text report still goes to the best channel the players are in.
      const text = this.chooseTextChannel(client, guildId, participantIds(), session.lastChannelId);
      textOnly = Boolean(text) && [...requiredTargets].every((id) => text!.id === id);
    }
    if (!voiceChannel && !textOnly) {
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
    session.waiting.delete(match.matchId);
    const progress = this.progressOf(session, match);
    try {
      return await this.attempt(client, guildId, session, match, progress, boundParticipants, requiredTargets, result, textOnly);
    } catch (error) {
      // A full queue tried nothing, so like a cancellation it leaves the match for the next poll without counting.
      if (error instanceof AnnouncementCancelledError || error instanceof AnnouncementQueueFullError
        || !this.current(guildId, session)) throw error;
      // Failed TTS, transport or a report that cannot be built leaves every baseline untouched so the next poll retries,
      // up to the cap.
      if (++progress.voiceFailures >= MAX_VOICE_ATTEMPTS) {
        this.consume(guildId, session, match, progress);
        if (progress.rankCast) this.finishRankVoice(progress.rankCast, progress.textPosted ? "given_up" : "dropped");
        this.dependencies.info(`Gave up on the voice report of match ${match.matchId} after ${progress.voiceFailures} failed attempts; `
          + `${progress.textPosted ? "its text report was posted" : "its text report was not posted"}, and it is not retried.`);
      }
      throw error;
    }
  }

  /** One attempt at a match that has a channel: timeline, text report, then voice. Any error but a cancellation counts toward the cap. */
  private async attempt(
    client: Client,
    guildId: string,
    session: MonitorSession,
    match: PendingMatch,
    progress: MatchProgress,
    boundParticipants: BoundParticipant[],
    requiredTargets: Set<string>,
    result: PollResult,
    textOnly = false,
  ): Promise<boolean> {
    const detail = match.detail!;
    const participantIds = () => this.liveParticipantIds(guildId, boundParticipants);
    const inFlight = progress.posting;
    if (inFlight && !progress.postUnknown) {
      // An earlier session stopped while its text post was in flight: whether to post again depends on how that went.
      const settled = await this.untilSettled(inFlight, session.controller.signal, this.dependencies.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS);
      if (!this.current(guildId, session)) throw new AnnouncementCancelledError();
      if (!settled && progress.posting === inFlight) {
        // Never post twice: the old send may still land, so the text is skipped and only the voice is spoken.
        progress.postUnknown = true;
        this.dependencies.log(new Error(`Warning: the text report of match ${match.matchId} is still in flight after `
          + `${((this.dependencies.inFlightWaitMs ?? IN_FLIGHT_WAIT_MS) / 1000).toFixed(0)} s; it is not posted again and the voice goes on.`));
      }
    }
    if (progress.events === undefined) {
      // The first LP reads wait inside the timeline's wait, never longer, so they add nothing to the worst case.
      const [events] = await Promise.all([
        this.timeline(match.matchId, detail, session.controller.signal),
        this.rankWait(match.matchId, session.controller.signal),
      ]);
      progress.events = events;
      if (!this.current(guildId, session)) throw new AnnouncementCancelledError();
    }
    // Chosen after the timeline request, which can take a few seconds: a player who reached a channel the voice can use
    // meanwhile gets the voice after all.
    const voiceChannel = this.chooseChannel(client, guildId, participantIds(), session.lastChannelId);
    if (voiceChannel) textOnly = false;
    const initial = voiceChannel ?? (textOnly ? this.chooseTextChannel(client, guildId, participantIds(), session.lastChannelId) : null);
    if (!initial) throw new AnnouncementCancelledError();
    const detected: DetectedMatch = { matchId: match.matchId, detail, boundParticipants, channelId: initial.id };
    // The speaker is fixed with the text; a later majority move changes only where it plays,
    // and a retry keeps the same speaker while they still own the account and can hear it.
    const speaker = (textOnly ? undefined : this.previousSpeaker(client, guildId, session, progress, boundParticipants))
      ?? this.perspective(client, guildId, session, detected.boundParticipants, initial, textOnly)!;
    progress.speakerPuuid = speaker.puuid;
    // The party is every tracked player on the speaker's team, in voice or not; a friend on the other team is an enemy here.
    const party = this.liveParticipants(guildId, boundParticipants)
      .filter((participant) => participant.teamId === speaker.teamId)
      .map(({ memberId, puuid }) => ({ memberId, puuid }));
    const announcement = buildMatchAnnouncement(detail, speaker.puuid, this.dependencies.mock(), { events: progress.events, party });
    let pick = initial.id;
    const resolveTarget = () => {
      const chosen = this.chooseChannel(client, guildId, participantIds(), pick);
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
      if (++queueResolves >= 2 && target && !playing) {
        playing = true;
        this.dependencies.info(`Match ${match.matchId} starts playing in voice channel ${(target as { name?: string }).name ?? target.id} `
          + `${secondsSince(match.detectedAt!)} s after detection.`);
      }
      return target;
    };
    // Rebinding or unbinding the speaker always cancels; an unrelated bind does not.
    // The speaker must still be in voice before generation and before joining, but once playing, a speaker who leaves
    // does not cut off teammates who stay: only the channel choice can stop it then.
    const canPlay = () => this.current(guildId, session)
      && this.ownerOf(guildId, speaker.puuid) === speaker.memberId
      && (playing || session.present.has(speaker.memberId))
      && Boolean(resolveTarget());
    // The text goes out only when the voice is about to be queued, so a report that cannot play yet posts nothing.
    // A text-only report has no voice to wait for.
    if (!textOnly && !canPlay()) throw new AnnouncementCancelledError();
    if (!progress.rankCast && this.dependencies.rank) {
      progress.rankCast = {
        matchId: match.matchId, client, guildId, session, channel: initial, detail, party,
        requiredTargets: new Set(requiredTargets), announced: new Set(), pendingLines: [], reportVoice: "pending",
      };
    }
    if (!progress.textPosted && !progress.postUnknown) {
      await this.postReport(guildId, initial, boundParticipants, progress, announcement, speaker.puuid, result,
        this.pregameRecap(guildId, match.matchId, announcement), { matchId: match.matchId, party, cast: progress.rankCast });
      if (!this.current(guildId, session)) throw new AnnouncementCancelledError();
    }
    if (textOnly) return this.finishTextOnly(guildId, session, match, progress, initial);
    await this.dependencies.announce(
      guildId,
      announcement.speech,
      getAnnouncerState(guildId).voiceStyle,
      resolveForQueue,
      canPlay,
      session.controller.signal,
    );
    if (!this.current(guildId, session)) throw new AnnouncementCancelledError();
    // The text could not be posted, for example without Send Messages, but the voice was heard: record what it said.
    if (!progress.textPosted) this.recordHorses(guildId, progress, announcement, speaker.puuid);
    this.consume(guildId, session, match, progress);
    // Only now may a 段位播报 line be queued, behind nothing: it never plays before or over the report. This comes after
    // consume and cannot throw, so a rank failure can never replay the report or count as a voice failure.
    if (progress.rankCast) this.finishRankVoice(progress.rankCast, progress.textPosted ? "done" : "dropped");
    this.dependencies.info(`Announced match ${match.matchId} in voice ${secondsSince(match.detectedAt!)} s after detection.`);
    return true;
  }

  /**
   * The end of a text-only attempt: no player is in a channel the voice can use, so the posted text is the whole report.
   * Nothing here is a voice failure; a text that could not be posted is retried on the next poll, up to the same cap.
   */
  private finishTextOnly(guildId: string, session: MonitorSession, match: PendingMatch, progress: MatchProgress, channel: VoiceChannel): boolean {
    const name = (channel as { name?: string }).name ?? channel.id;
    if (!progress.textPosted && !progress.postUnknown) {
      if (++progress.voiceFailures >= MAX_VOICE_ATTEMPTS) {
        this.consume(guildId, session, match, progress);
        if (progress.rankCast) this.finishRankVoice(progress.rankCast, "dropped");
        this.dependencies.info(`Gave up on the text report of match ${match.matchId} after ${progress.voiceFailures} failed posts.`);
      }
      return false;
    }
    this.consume(guildId, session, match, progress);
    if (progress.rankCast) this.finishRankVoice(progress.rankCast, "given_up");
    this.dependencies.info(`Announced match ${match.matchId} as text only in ${name}${progress.textPosted ? "" : " (its post is unconfirmed)"}: `
      + "no player is in a voice channel the bot can join and speak in.");
    return true;
  }

  /** The speaker of an earlier attempt, while that member still owns the account, is covered by the session and is in a usable channel. */
  private previousSpeaker(
    client: Client,
    guildId: string,
    session: MonitorSession,
    progress: MatchProgress,
    participants: BoundParticipant[],
  ): BoundParticipant | undefined {
    const previous = participants.find((participant) => participant.puuid === progress.speakerPuuid);
    if (!previous || this.ownerOf(guildId, previous.puuid) !== previous.memberId) return undefined;
    if (!session.present.has(previous.memberId) || !this.dependencies.resolveChannel(client, guildId, previous.memberId)) return undefined;
    return previous;
  }

  /** The match's progress entry, created when it first gets a usable channel. */
  private progressOf(session: MonitorSession, match: PendingMatch): MatchProgress {
    let progress = session.progress.get(match.matchId);
    if (!progress) {
      progress = { detail: match.detail!, detectedAt: match.detectedAt!, reporters: new Set(), textPosted: false, voiceFailures: 0 };
      session.progress.set(match.matchId, progress);
      if (session.progress.size > PROGRESS_LIMIT) session.progress.delete(session.progress.keys().next().value!);
    }
    for (const account of match.reporters) progress.reporters.add(account.puuid);
    return progress;
  }

  /**
   * Waits for a promise that never rejects, at most `limitMs`; stopping the session ends the wait at once, so a stuck send
   * never holds a poll. Resolves false only when the limit ran out first. The timer is cleared however the wait ends and never
   * keeps the process alive.
   */
  private async untilSettled(pending: Promise<void>, signal: AbortSignal, limitMs: number): Promise<boolean> {
    if (signal.aborted) return true;
    let onAbort: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          onAbort = () => resolve(true);
          signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => resolve(false), limitMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }

  /**
   * Timeline moments, or null when they fail or take too long; the report then uses statistics only.
   * Stopping the session ends the wait at once with a cancellation, leaving the timeline unfetched.
   */
  private async timeline(matchId: string, detail: MatchDetail, signal: AbortSignal): Promise<readonly MatchEvent[] | null> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const waitMs = this.dependencies.timelineWaitMs ?? TIMELINE_WAIT_MS;
    try {
      if (signal.aborted) throw new AnnouncementCancelledError();
      const request = this.dependencies.events(matchId, detail);
      request.catch(() => undefined);
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer after ${(waitMs / 1000).toFixed(1)} s`)), waitMs);
      });
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new AnnouncementCancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([request, expired, stopped]);
    } catch (error) {
      if (error instanceof AnnouncementCancelledError) throw error;
      this.dependencies.info(`Timeline for match ${matchId} is unavailable (${errorMessage(error)}); `
        + "the report uses end-of-game statistics only.");
      return null;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Post the text report to the voice channel's chat, mentioning the match's tracked players who are in that channel,
   * then write the 马厩 records of the announcement it shows. A failed post counts as an error but does not stop the voice.
   */
  private async postReport(
    guildId: string,
    channel: VoiceChannel,
    boundParticipants: BoundParticipant[],
    progress: MatchProgress,
    announcement: MatchAnnouncement,
    perspectivePuuid: string,
    result: PollResult,
    recap?: string,
    rank: { matchId: string; party: readonly RankMember[]; cast?: RankCast } = { matchId: progress.detail.metadata.matchId, party: [] },
  ): Promise<void> {
    const { matchId, party, cast } = rank;
    const mentions = this.liveParticipantIds(guildId, boundParticipants).filter((memberId) => channel.members.has(memberId));
    const message = (rankRows: readonly string[]): MessageCreateOptions => ({
      ...(mentions.length > 0 ? { content: mentions.map((memberId) => `<@${memberId}>`).join(" ") } : {}),
      // The 车队内战, when there is one, is a second embed right after the report; it mentions without pinging.
      embeds: [
        buildHorseReportEmbed(announcement.report, recap, rankRows),
        ...(announcement.party ? [buildPartyEmbed(announcement.party)] : []),
      ],
      allowedMentions: { parse: [], roles: [], users: mentions, repliedUser: false },
    });
    const rows = this.rankRows(matchId, party);
    // Remembered before Discord answers: a session that starts while the post is in flight waits for it instead of
    // posting again, and settle tells it how the post went.
    let settle!: () => void;
    progress.posting = new Promise<void>((resolve) => { settle = resolve; });
    this.remember(guildId, matchId, progress);
    let posted: Message;
    try {
      posted = await channel.send(message(rows.lines));
    } catch (error) {
      // Not posted, so not remembered: tried again if the voice also fails and the match is retried, or by the next
      // session that sees the match.
      progress.posting = undefined;
      // A session that gave up waiting may post it after all if it retries; one that already spoke does not.
      progress.postUnknown = false;
      this.forgetPost(guildId, matchId, progress);
      settle();
      result.errors++;
      this.report(guildId, error);
      return;
    }
    progress.textPosted = true;
    progress.reportMessage = posted;
    progress.posting = undefined;
    // Posted, so no session of this guild posts it again, whoever leaves and returns.
    this.remember(guildId, matchId, progress);
    settle();
    // A retry may post in another channel, or for another team: the 段位播报 follows the report that was actually posted.
    if (cast) {
      cast.channel = channel;
      cast.party = party;
    }
    // A promotion or demotion the first reads already show goes out right after the report's text.
    if (cast) void this.castRank(cast);
    if (rows.pending) this.editRankLater(guildId, progress, matchId, party, message, cast);
    this.recordHorses(guildId, progress, announcement, perspectivePuuid);
    this.recordRanks(guildId, progress.detail, matchId, party);
  }

  /**
   * Stores the final rows of the reported team's bound members: a change, promotion, demotion, placement or an
   * unattributable change. Pending, stale and unavailable rows are not stored. Each member is stored once per match, however
   * often the rows are read, because the key ignores a repeat. Only members who still own the account they played on
   * are stored, read live each time, so /unbind and /stable-erase are never undone by a late write. A failure is logged and
   * never affects the report.
   */
  private recordRanks(guildId: string, detail: MatchDetail, matchId: string, party: readonly RankMember[]): void {
    const rank = this.dependencies.rank;
    const record = this.dependencies.recordRank;
    // After shutdown the database is closed, and a store call would open it again.
    if (this.closed || !rank || !record) return;
    try {
      const recordedAt = Date.now();
      const mock = this.dependencies.mock();
      const results: RankResult[] = [];
      for (const { memberId, puuid } of party) {
        // The late write runs minutes after the report: a member unbound or erased meanwhile gets no row back.
        if (this.ownerOf(guildId, puuid) !== memberId) continue;
        const row = rank.row(matchId, puuid);
        const result = row && buildRankResult(row, {
          guildId, discordUserId: memberId, matchId, mock, puuid, gameEndTimestamp: detail.info.gameEndTimestamp, recordedAt,
        });
        if (result) results.push(result);
      }
      if (results.length === 0) return;
      const saved = record(results);
      if (saved > 0) this.dependencies.info(`Saved ${saved} LP result${saved === 1 ? "" : "s"} for match ${matchId}.`);
    } catch (error) {
      this.dependencies.log(new Error(`The LP results of match ${matchId} were not saved: ${errorMessage(error)}`));
    }
  }

  /** Reads the account as the before-value of its next ranked game. A failure is logged and changes nothing else. */
  private rankSnapshot(puuid: string): void {
    try {
      this.dependencies.rank?.snapshot([puuid]);
    } catch (error) {
      this.dependencies.log(new Error(`The LP snapshot was skipped: ${errorMessage(error)}`));
    }
  }

  /**
   * Starts the after-reads of a ranked match that counted, for every bound player of it in this guild, both teams:
   * a successful read is the next game's before-value, though only the reported team gets a row.
   * A remake or an aborted game reads nothing.
   */
  private rankFinished(guildId: string, matchId: string, detail: MatchDetail): void {
    const rank = this.dependencies.rank;
    const { info } = detail;
    if (!rank || info.earlySurrender || info.aborted || !rankedQueueFor(info.queueId)) return;
    try {
      const members = this.dependencies.members(guildId);
      const label = (puuid: string) => {
        const account = members.flatMap((member) => member.accounts).find((candidate) => candidate.puuid === puuid);
        return account ? `${account.gameName}#${account.tagLine}` : "an unbound account";
      };
      const accounts = this.boundParticipants(guildId, detail).map(({ puuid }) => ({ puuid, label: label(puuid) }));
      rank.matchFinished({ matchId, queueId: info.queueId, gameEndTimestamp: info.gameEndTimestamp, accounts });
    } catch (error) {
      this.dependencies.log(new Error(`The LP reads of match ${matchId} were not started: ${errorMessage(error)}`));
    }
  }

  /**
   * Waits for the match's first LP reads at most as long as the timeline wait, and ends at once when the session stops.
   * It never rejects: LP can make a report wait, but never fail.
   */
  private async rankWait(matchId: string, signal: AbortSignal): Promise<void> {
    const rank = this.dependencies.rank;
    if (!rank) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) return;
      await Promise.race([
        Promise.resolve().then(() => rank.firstReads(matchId)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.dependencies.timelineWaitMs ?? TIMELINE_WAIT_MS); }),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      this.dependencies.log(new Error(`The LP reads of match ${matchId} broke off: ${errorMessage(error)}`));
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The 段位变化 rows of the reported team's bound members, in party order, and whether any is still pending.
   * Strangers, enemies and a friend on the other team are not in the party, so they never get a row.
   * A failure here is logged and leaves the field out.
   */
  private rankRows(matchId: string, party: readonly RankMember[]): { lines: string[]; pending: boolean } {
    const rank = this.dependencies.rank;
    if (!rank) return { lines: [], pending: false };
    try {
      const lines: string[] = [];
      let pending = false;
      for (const { memberId, puuid } of party) {
        const row = rank.row(matchId, puuid);
        if (!row) continue;
        const text = rankRowText(memberId, row);
        if (!text) continue;
        lines.push(text);
        if (row.state.kind === "pending") pending = true;
      }
      return { lines, pending };
    } catch (error) {
      this.dependencies.log(new Error(`The 段位变化 of match ${matchId} was left out: ${errorMessage(error)}`));
      return { lines: [], pending: false };
    }
  }

  /**
   * Edits the posted report once, when the pending rows have settled, with the same mentions and allowedMentions.
   * It runs apart from the poll, and never after the monitor shut down. A deleted report is an info line; any other
   * failure is logged.
   */
  private editRankLater(
    guildId: string,
    progress: MatchProgress,
    matchId: string,
    party: readonly RankMember[],
    message: (rankRows: readonly string[]) => MessageCreateOptions,
    cast?: RankCast,
  ): void {
    const rank = this.dependencies.rank!;
    void Promise.resolve()
      .then(() => rank.settled(matchId, party.map(({ puuid }) => puuid)))
      .then(async () => {
        const posted = progress.reportMessage;
        if (this.closed || !posted) return;
        // The rows have settled: the ones that became final since the report went out are stored, whether or not the edit succeeds.
        this.recordRanks(guildId, progress.detail, matchId, party);
        try {
          const { content, embeds, allowedMentions } = message(this.rankRows(matchId, party).lines);
          await posted.edit({ ...(content === undefined ? {} : { content }), embeds, allowedMentions });
          this.dependencies.info(`Updated the 段位变化 of match ${matchId}.`);
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownMessage) {
            this.dependencies.info(`The report of match ${matchId} was deleted, so its 段位变化 was not updated.`);
          } else {
            this.dependencies.log(new Error(`The 段位变化 of match ${matchId} was not updated: ${errorMessage(error)}`));
          }
        }
        // The rows have settled, whether or not the edit went out: a promotion or demotion that only the late read
        // shows is announced now, unless the first reads already announced this match.
        if (cast) await this.castRank(cast);
      })
      .catch((error: unknown) => {
        this.dependencies.log(new Error(`The 段位变化 of match ${matchId} was not updated: ${errorMessage(error)}`));
      });
  }

  /**
   * The bound members of the reported team whose row in this match is a promotion or demotion, in party order.
   * A failure here is logged and announces nothing.
   */
  private rankMoves(matchId: string, party: readonly RankMember[]): Array<RankMember & RankMove> {
    const rank = this.dependencies.rank;
    if (!rank) return [];
    try {
      const moves: Array<RankMember & RankMove> = [];
      for (const member of party) {
        const row = rank.row(matchId, member.puuid);
        const move = row && rankMoveOf(row);
        if (move) moves.push({ ...member, ...move });
      }
      return moves;
    } catch (error) {
      this.dependencies.log(new Error(`The LP 段位播报 of match ${matchId} was left out: ${errorMessage(error)}`));
      return [];
    }
  }

  /**
   * Announces the promotions and demotions of the match that were not announced yet: one embed with a line for each such
   * member, in the report's channel, then their voice line. Nobody is announced twice, but a member whose row only
   * settles later, with the late update, gets their own follow-up.
   * It never rejects: a failure is logged and changes nothing else.
   */
  private async castRank(cast: RankCast): Promise<void> {
    try {
      if (this.closed || cast.reportVoice === "dropped") return;
      const moves = this.rankMoves(cast.matchId, cast.party).filter((move) => !cast.announced.has(move.puuid));
      const lines = moves.flatMap((move) => rankMoveText(move.memberId, move) ?? []);
      if (lines.length === 0) return;
      // Marked before anything is awaited, so the first reads and the late update can never announce the same member.
      for (const move of moves) cast.announced.add(move.puuid);
      const mock = this.dependencies.mock();
      const spoken: RankVoiceMove[] = moves.map((move) => ({
        ...move,
        name: cast.detail.info.participants.find((participant) => participant.puuid === move.puuid)?.riotIdGameName ?? "",
      }));
      const line = buildRankVoiceLine({ matchId: cast.matchId, mock, moves: spoken });
      try {
        await cast.channel.send({ embeds: [buildRankAnnouncementEmbed(lines, mock)], allowedMentions: NO_MENTIONS });
        this.dependencies.info(`Posted the 段位播报 of match ${cast.matchId}.`);
      } catch (error) {
        this.dependencies.log(new Error(`The 段位播报 of match ${cast.matchId} was not posted: ${errorMessage(error)}`));
      }
      if (line) cast.pendingLines.push(line);
      this.flushRank(cast);
    } catch (error) {
      this.dependencies.log(new Error(`The LP 段位播报 of match ${cast.matchId} failed: ${errorMessage(error)}`));
    }
  }

  /** The report's voice is over (or never will be): lines waiting for it are queued now, or stay text only. Never throws. */
  private finishRankVoice(cast: RankCast, state: "done" | "given_up" | "dropped"): void {
    cast.reportVoice = state;
    try {
      if (state === "dropped") {
        this.dependencies.info(`The 段位播报 of match ${cast.matchId} was dropped: the report's text was not posted.`);
      }
    } catch {
      // A failing log sink must not reach the report.
    }
    this.flushRank(cast);
  }

  /**
   * Queues the waiting 段位播报 voice lines, each one plain job in the guild's voice queue with one attempt and no retry.
   * A line needs a finished report voice, a live session and a member of the reported team who is still in a usable voice
   * channel; otherwise it stays text only. Nothing here throws, and a failure never counts toward the report's attempts.
   */
  private flushRank(cast: RankCast): void {
    try {
      if (cast.pendingLines.length === 0 || cast.reportVoice === "pending" || this.closed) return;
      const lines = cast.pendingLines.splice(0);
      if (cast.reportVoice !== "done") {
        this.dependencies.info(`The 段位播报 of match ${cast.matchId} is text only: the report's voice was not completed.`);
        return;
      }
      for (const line of lines) this.speakRank(cast, line);
    } catch (error) {
      this.dependencies.log(new Error(`The LP 段位播报 voice of match ${cast.matchId} failed: ${errorMessage(error)}`));
    }
  }

  private speakRank(cast: RankCast, line: string): void {
    const { client, guildId, session } = cast;
    if (!this.current(guildId, session)) return;
    let pick: string | undefined;
    // Only the reported team's members, still bound to their account, count: an enemy or a stranger in voice does not.
    const ids = () => cast.party.filter(({ memberId, puuid }) => this.ownerOf(guildId, puuid) === memberId).map(({ memberId }) => memberId);
    const resolveTarget = (): VoiceChannel | null => {
      const chosen = this.chooseChannel(client, guildId, ids(), pick);
      if (!chosen) return null;
      pick = chosen.id;
      if ([...cast.requiredTargets].some((id) => chosen.id !== id)) return null;
      return chosen;
    };
    const canPlay = () => this.current(guildId, session) && Boolean(resolveTarget());
    if (!canPlay()) {
      this.dependencies.info(`The 段位播报 of match ${cast.matchId} is text only: nobody of the team is in a voice channel announcements can use.`);
      return;
    }
    void Promise.resolve()
      .then(() => this.dependencies.announce(guildId, line, getAnnouncerState(guildId).voiceStyle, resolveTarget, canPlay, session.controller.signal))
      .then(() => {
        this.dependencies.info(`Spoke the 段位播报 of match ${cast.matchId}.`);
      }, (error: unknown) => {
        if (error instanceof AnnouncementCancelledError || error instanceof AnnouncementQueueFullError) {
          this.dependencies.info(`The 段位播报 voice line of match ${cast.matchId} was not played: ${errorMessage(error)}`);
          return;
        }
        this.dependencies.log(new Error(`The 段位播报 voice line of match ${cast.matchId} failed: ${errorMessage(error)}`));
      });
  }

  /**
   * The 锦囊回顾 line for the report's embed, or undefined. Text only: it never reaches the speech.
   * It needs the pregame pick of this match in the same data mode, still bound to that member, on the report's team,
   * and a rated match. A failure here is logged and never affects the report.
   */
  private pregameRecap(guildId: string, matchId: string, announcement: MatchAnnouncement): string | undefined {
    try {
      const memory = this.gameStartMemory.get(guildId);
      const pick = memory && recallPick(memory, matchId, (this.dependencies.gameStart?.now ?? Date.now)());
      if (!pick || pick.mock !== this.dependencies.mock()) return undefined;
      const bound = this.dependencies.members(guildId)
        .find((member) => member.discordUserId === pick.memberId)?.accounts.some((candidate) => candidate.puuid === pick.puuid);
      if (!bound) return undefined;
      // The tier and the name are the report's own: only its team is listed, and a remake or aborted match lists nobody.
      const player = announcement.players?.find((candidate) => candidate.puuid === pick.puuid);
      return player ? buildPregameRecap({ matchId, name: player.name, tier: player.tier }) : undefined;
    } catch (error) {
      this.dependencies.log(new Error(`The 锦囊回顾 of match ${matchId} was left out: ${errorMessage(error)}`));
      return undefined;
    }
  }

  /** Writes the posted announcement's 马厩 records; a failure is logged and never affects the announcement. */
  private recordHorses(guildId: string, progress: MatchProgress, announcement: MatchAnnouncement, perspectivePuuid: string): void {
    // After shutdown the database is closed, and a store call would open it again.
    if (this.closed) return;
    const matchId = progress.detail.metadata.matchId;
    try {
      // Read just before the write, so a member unbound during the report is simply absent.
      const tracked = this.dependencies.members(guildId).flatMap((member) =>
        member.accounts.map((account) => ({ discordUserId: member.discordUserId, puuid: account.puuid })));
      const saved = this.dependencies.record(buildHorseRecords({
        guildId,
        detail: progress.detail,
        tracked,
        mock: this.dependencies.mock(),
        announcement: { announcement, perspectivePuuid, events: progress.events },
      }));
      if (saved > 0) this.dependencies.info(`Saved ${saved} 马厩 record${saved === 1 ? "" : "s"} for match ${matchId}.`);
    } catch (error) {
      this.dependencies.log(new Error(`The 马厩 records of match ${matchId} were not saved: ${errorMessage(error)}`));
    }
  }

  /**
   * The match is done: it is never announced again in this session, the accounts that reported it move past it, and
   * the guild remembers it, so an account that reports it later, after a return or a lagging match list, moves past it too.
   */
  private consume(guildId: string, session: MonitorSession, match: PendingMatch, progress: MatchProgress): void {
    session.announced.add(match.matchId);
    if (session.announced.size > 200) session.announced.delete(session.announced.values().next().value!);
    session.progress.delete(match.matchId);
    for (const account of match.reporters) {
      if (session.accounts.get(account.puuid)?.baselined) setLastMatchId(guildId, account.puuid, match.matchId);
    }
    this.remember(guildId, match.matchId, progress, true);
  }
}

/** The member's voice channel when it passes the mock-mode TEST_* restrictions, whatever the bot can do in it. */
function allowedMemberChannel(client: Client, guildId: string, userId: string): VoiceChannel | null {
  const channel = client.guilds.cache.get(guildId)?.members.cache.get(userId)?.voice.channel;
  if (!(channel instanceof VoiceChannel)) return null;
  if (getRiotMode() === "mock") {
    const testGuildId = process.env.TEST_GUILD_ID?.trim();
    const testChannelId = process.env.TEST_VOICE_CHANNEL_ID?.trim();
    if ((testGuildId && guildId !== testGuildId) || (testChannelId && channel.id !== testChannelId)) return null;
  }
  return channel;
}

export function resolveMonitoredVoiceChannel(client: Client, guildId: string, userId: string): VoiceChannel | null {
  const channel = allowedMemberChannel(client, guildId, userId);
  return channel && isUsableVoiceChannel(channel) ? channel : null;
}

/** The member's channel for the text report when the voice cannot use it: the bot only needs View Channel and Send Messages there. */
export function resolveMonitoredTextChannel(client: Client, guildId: string, userId: string): VoiceChannel | null {
  const channel = allowedMemberChannel(client, guildId, userId);
  if (!channel) return null;
  const permissions = channel.permissionsFor(client.user!);
  return permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) ? channel : null;
}

/** The game start watcher's errors, with their own prefix so they are never read as a failed match poll. */
export function logGameStartFailure(error: unknown): void {
  logError(`Game start check failed: ${errorMessage(error)}`);
}

/** The process-wide LP tracker: one serialized reader for every guild, through the league requester. Exported for tests. */
export const rankTracker = new RankTracker({
  readEntries: async (puuid) => {
    const { entries, dropped } = await getLeagueEntries(puuid);
    if (dropped > 0) logInfo(`League-v4 sent ${dropped} malformed ranked entr${dropped === 1 ? "y" : "ies"}; ${dropped === 1 ? "it was" : "they were"} left out.`);
    return entries;
  },
  mock: () => getRiotMode() === "mock",
  log: (error) => logError(`LP tracking failed: ${errorMessage(error)}`),
  info: logInfo,
});

const monitor = new GameMonitor({
  latest: getLatestSRMatchId,
  detail: getMatchDetail,
  members: listTrackedMembers,
  resolveChannel: resolveMonitoredVoiceChannel,
  resolveTextChannel: resolveMonitoredTextChannel,
  announce: announceTextToCurrentChannel,
  events: (matchId, detail) => fetchMatchEvents(matchId, detail),
  record: recordHorseRecords,
  rank: rankTracker,
  recordRank: recordRankResults,
  mock: () => getRiotMode() === "mock",
  log: (error) => logError(`Match monitoring failed: ${errorMessage(error)}`),
  info: logInfo,
  gameStart: {
    activeGame: (puuid) => getActiveGame(puuid),
    records: (guildId, discordUserId, mock) => listHorseRecords(guildId, { mock, discordUserId, order: "desc", limit: 200 }),
    pregameVoice: getPregameVoiceEnabled,
    voiceStyle: (guildId) => getAnnouncerState(guildId).voiceStyle,
    log: logGameStartFailure,
  },
});

/** Point the guild's session at the tracked members who are in voice now; an empty list stops it. */
export function syncMonitoring(client: Client, guildId: string, presentMemberIds: Iterable<string>): void {
  monitor.sync(client, guildId, presentMemberIds);
}

/** A /bind or /unbind of the member: no baseline of theirs from before it is kept or restored. */
export function forgetMemberBaselines(guildId: string, memberId: string): void {
  monitor.forgetMember(guildId, memberId);
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

/** Check the guild's present accounts for a game on its loading screen now and wait for the 锦囊 of `matchId`; see /simulate. */
export function pollGameStartNow(guildId: string, matchId?: string, requiredVoiceChannelId?: string): ReturnType<GameMonitor["pollGameStart"]> {
  return monitor.pollGameStart(guildId, matchId, requiredVoiceChannelId);
}

/** Mock mode only, for /simulate: makes the accounts' current mock entries the before-value of their next game. */
export function rebaseMockRank(puuids: readonly string[]): Promise<void> {
  return rankTracker.rebase(puuids);
}

/** At shutdown: stops every session and the LP tracker, so no queued read or late edit outlives the bot. */
export function stopAllPolling(): void {
  monitor.stopAll();
  rankTracker.stop();
}
