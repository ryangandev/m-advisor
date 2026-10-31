import type { Client, VoiceChannel } from "discord.js";
import type { ActiveGame, TrackedMember } from "../types";
import type { HorseRecord } from "../store/horseRecordStore";
import type { VoiceStyle } from "../store/announcerStore";
import { RiotApiError } from "./riotData";
import { isAnnouncedGame, isLoading, isSpectatorAuthError, matchIdOf } from "../utils/riotSpectatorApi";
import { boundParticipants, chooseChannel, liveParticipantIds, liveParticipants, perspective } from "./channelChoice";
import type { BoundParticipant, ResolveChannel } from "./channelChoice";
import { buildPregameBrief } from "./pregameBrief";
import type { PregameBrief, PregameTeammate } from "./pregameBrief";
import { buildPregameEmbed, pregameAllowedMentions, pregameMentionContent } from "../utils/pregameEmbed";
import { AnnouncementCancelledError, AnnouncementQueueFullError } from "./voiceAnnouncements";
import type { announceTextToCurrentChannel } from "./voiceAnnouncements";
import { rankedQueueFor } from "./rankMath";
import type { RankTracking } from "./rankTracker";

/** How often present members' accounts are asked whether they are in a game. */
export const GAME_START_INTERVAL_MS = 20_000;
/**
 * An account already seen in a game is asked again only every this many ticks (2 minutes), until it is out of it,
 * or earlier once the match it was seen in is finished.
 */
export const IN_GAME_RECHECK_TICKS = 6;
/** A line that has not started playing this long after detection is dropped: the loading screen is over by then. */
export const GAME_START_WINDOW_MS = 90_000;
/** A game seen by an account whose previous check found no game is announced while it has run at most this long. */
export const FRESH_GAME_SECONDS = 60;
/** A player's start read is asked again at most this many times after the first attempt, per game. */
export const RANK_START_RETRIES = 3;
/** At most this many games are remembered per session, and per guild across sessions; the oldest is forgotten first. */
const GAME_STARTS_LIMIT = 50;
/** A guild remembers a game whose 锦囊 went out this long, far past any loading screen. */
export const ANNOUNCED_MEMORY_MS = 15 * 60_000;
/**
 * A guild remembers the 军师之选 of a game this long: a long game, plus a report that waits for a channel.
 * Far longer than ANNOUNCED_MEMORY_MS, which only has to cover a loading screen.
 */
export const PICK_MEMORY_MS = 3 * 60 * 60_000;
/** Records read per teammate; the brief uses the latest ten and the champion history among them. */
const RECORDS_PER_TEAMMATE = 200;
const SMITE = 11;

/** What the watcher needs from outside: Riot, Discord, the store and the voice queue. Tests pass fakes. */
export interface GameStartDependencies {
  /** The account's game right now, or null when it is in none; see `getActiveGame`. */
  activeGame: (puuid: string) => Promise<ActiveGame | null>;
  /** Tracked members of a guild in bind order, read live. */
  members: (guildId: string) => TrackedMember[];
  resolveChannel: ResolveChannel;
  /** The channel for the text when no player is in one the voice can use (full, AFK, no Connect or Speak); without it nothing is posted then. */
  resolveTextChannel?: ResolveChannel;
  announce: typeof announceTextToCurrentChannel;
  /** A member's horse records of the given data mode, newest first. */
  records: (guildId: string, memberId: string, mock: boolean) => readonly HorseRecord[];
  /** The guild's pregame voice switch; text is always posted. */
  pregameVoice: (guildId: string) => boolean;
  voiceStyle: (guildId: string) => VoiceStyle;
  mock: () => boolean;
  log: (error: unknown) => void;
  info: (message: string) => void;
  /** The clock; Date.now by default. Tests pass a fake one. */
  now?: () => number;
  /** The LP tracker: a ranked game's start reads its bound players' rank as the before-value. */
  rank?: RankTracking;
}

/** What the watcher needs from the monitoring session that owns it. */
export interface GameStartHost {
  client: Client;
  guildId: string;
  /** Aborted when the session stops. */
  signal: AbortSignal;
  /** The session is still the guild's current one. */
  current: () => boolean;
  /** The member is in voice and covered by the session. */
  isPresent: (memberId: string) => boolean;
  /** The finished match with this ID is being or has been announced by the session. */
  finished: (matchId: string) => boolean;
  /** The channel of the latest announcement, so ties do not bounce between channels. */
  lastChannelId: () => string | undefined;
  rememberChannel: (channelId: string) => void;
  /** The guild's memory, kept by the monitor across sessions. */
  memory: GameStartMemory;
}

/**
 * What a guild remembers about game starts across monitoring sessions, so a member who leaves and rejoins voice
 * during loading neither hears the 锦囊 twice nor makes the watcher exceed its request budget.
 */
export interface GameStartMemory {
  /** Games whose 锦囊 went out (its text was attempted), by match ID, with the time; forgotten after ANNOUNCED_MEMORY_MS. */
  announced: Map<string, number>;
  /** The 军师之选 of games whose 锦囊 had one, by match ID, for the 锦囊回顾; at most GAME_STARTS_LIMIT, each for PICK_MEMORY_MS. */
  picks: Map<string, GamePick>;
  /** When each account was last asked, by PUUID; an account is asked at most once per GAME_START_INTERVAL_MS. */
  checked: Map<string, number>;
}

/** The 军师之选 of a game: the member, the account they played on, and which data mode the card was in. */
export interface GamePick {
  memberId: string;
  puuid: string;
  /** Mock and real never mix: a mock pick decorates only a mock report, and the reverse. */
  mock: boolean;
  at: number;
}

export function createGameStartMemory(): GameStartMemory {
  return { announced: new Map(), picks: new Map(), checked: new Map() };
}

/** Remembers a game's pick, dropping the expired ones first and then the oldest beyond the cap. */
export function rememberPick(memory: GameStartMemory, matchId: string, pick: GamePick): void {
  const { picks } = memory;
  for (const [id, remembered] of picks) if (pick.at - remembered.at >= PICK_MEMORY_MS) picks.delete(id);
  picks.delete(matchId);
  picks.set(matchId, pick);
  if (picks.size > GAME_STARTS_LIMIT) picks.delete(picks.keys().next().value!);
}

/** The game's pick while it is younger than PICK_MEMORY_MS, otherwise undefined. */
export function recallPick(memory: GameStartMemory, matchId: string, now: number): GamePick | undefined {
  const pick = memory.picks.get(matchId);
  return pick && now - pick.at < PICK_MEMORY_MS ? pick : undefined;
}

/** Where an account stands in the current presence of its member. */
type PresenceState =
  | { kind: "unknown" }
  | { kind: "notInGame" }
  | {
    kind: "inGame";
    gameId: number;
    matchId: string;
    checkedTick: number;
    /** The game's match was already finished at this check, so the early recheck it earns has been spent. */
    sawFinished: boolean;
  };

interface AccountPresence {
  /** The member who owned the account when the watcher first saw it; another owner means a fresh presence. */
  owner: string;
  state: PresenceState;
}

/** A ranked game whose players' start reads are still being waited for. */
interface RankStart {
  /** The first sighting, which a read must not predate. */
  since: number;
  /** Start reads asked for so far, by player; one more than the retries at most. */
  attempts: Map<string, number>;
  /** The accounts of this watcher that see the game; the entry goes with the last of them. */
  observers: Set<string>;
}

export type PregameVoiceOutcome = "played" | "off" | "failed" | "dropped" | "pending";

/** A game the session has decided about: announced (started) or skipped. Kept for dedup and for the optional 锦囊回顾. */
export interface GameStartEntry {
  matchId: string;
  status: "started" | "skipped";
  game: ActiveGame;
  detectedAt: number;
  /** Fixed with the text the first time a participant had a usable channel. */
  brief?: PregameBrief;
  /** The bound player whose team the brief rates; the 军师之选 is on that team. */
  teamId?: number;
  pickMemberId?: string;
  pickPuuid?: string;
  /** The channel the text went to, or null when the post failed. Undefined until the text was attempted. */
  textChannelId?: string | null;
  /** The voice line: waiting for a try, queued, or settled. */
  voice: "waiting" | "queued" | PregameVoiceOutcome;
  /** Settles when a queued voice line settles. */
  voicePromise?: Promise<void>;
  /** A /simulate run that needs the line in its channel. */
  requiredChannelId?: string;
}

export interface GameStartTickResult {
  /** Games announced (their 锦囊 decided) in this tick. */
  started: number;
  /** 锦囊 texts posted in this tick. */
  posted: number;
  errors: number;
}

/** What /simulate waits for: whether the text went out and how the voice line ended. */
export interface GameStartOutcome {
  textPosted: boolean;
  voice: PregameVoiceOutcome;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : "Unknown error";
const errorKey = (error: unknown): string => error instanceof RiotApiError ? `${error.code}:${error.status ?? ""}` : "other";

/**
 * Watches the present members' accounts for a game on its loading screen and posts the 军师赛前锦囊 for it:
 * the text card in the voice channel's chat, then, when the guild's pregame voice is on, a short spoken line.
 * One per monitoring session; it has its own 20 second timer and in-flight check, apart from the match poll.
 */
export class GameStartWatcher {
  private readonly accounts = new Map<string, AccountPresence>();
  private readonly gameStarts = new Map<string, GameStartEntry>();
  /** Ranked games whose start read is not done yet, by match ID. */
  private readonly rankStarts = new Map<string, RankStart>();
  private readonly loggedErrors = new Set<string>();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<GameStartTickResult>;
  private tickAgain = false;
  private ticks = 0;
  private disabled = false;
  /** Members covered at the last sync, so only someone new triggers an early check. */
  private covered = new Set<string>();

  constructor(private readonly host: GameStartHost, private readonly dependencies: GameStartDependencies) {}

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  private live(): boolean {
    return !this.disabled && this.host.current() && !this.host.signal.aborted;
  }

  /** Starts the 20 second timer and checks right away, so a member who joins voice during loading still gets the 锦囊. */
  start(): void {
    if (this.timer || this.disabled) return;
    this.covered = new Set(this.dependencies.members(this.host.guildId)
      .filter((member) => this.host.isPresent(member.discordUserId)).map((member) => member.discordUserId));
    this.timer = setInterval(() => { void this.tick(); }, GAME_START_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.rankStarts.clear();
  }

  /** Whether the watcher gave up for this session, after Riot rejected the key for spectator. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** The decided game with this match ID, for the optional 锦囊回顾 on the finished report. */
  gameStart(matchId: string): Readonly<GameStartEntry> | undefined {
    return this.gameStarts.get(matchId);
  }

  /**
   * The members in voice changed: drop the state of accounts whose member left or no longer owns them,
   * and check soon when someone new is covered.
   */
  sync(members = this.dependencies.members(this.host.guildId)): void {
    this.prune(members);
    const covered = new Set(members.filter((member) => this.host.isPresent(member.discordUserId)).map((member) => member.discordUserId));
    const joined = [...covered].some((memberId) => !this.covered.has(memberId));
    this.covered = covered;
    if (joined && this.timer) this.tickSoon();
  }

  /** An account whose member left voice, was unbound or lost it starts over as unknown when it comes back. */
  prune(members = this.dependencies.members(this.host.guildId)): void {
    const owners = new Map<string, string>();
    for (const member of members) {
      if (!this.host.isPresent(member.discordUserId)) continue;
      for (const account of member.accounts) if (!owners.has(account.puuid)) owners.set(account.puuid, member.discordUserId);
    }
    for (const [puuid, presence] of this.accounts) {
      if (owners.get(puuid) === presence.owner) continue;
      this.accounts.delete(puuid);
      this.releaseRankStarts(puuid);
    }
  }

  /** An account no longer sees its game (it left, or the game is over): a ranked start nobody sees any more is forgotten. */
  private releaseRankStarts(puuid: string): void {
    for (const [matchId, start] of this.rankStarts) {
      start.observers.delete(puuid);
      if (start.observers.size === 0) this.rankStarts.delete(matchId);
    }
  }

  private tickSoon(): void {
    if (this.inFlight) this.tickAgain = true;
    else void this.tick();
  }

  /**
   * One check of every present account. A timer tick while one runs shares it.
   * A call with `requiredChannelId` (/simulate) waits for a running tick and then checks again, so it sees a game started just before.
   */
  tick(requiredChannelId?: string): Promise<GameStartTickResult> {
    if (!this.live()) return Promise.resolve({ started: 0, posted: 0, errors: 0 });
    if (this.inFlight) {
      if (requiredChannelId === undefined) return this.inFlight;
      return this.inFlight.then(() => this.tick(requiredChannelId));
    }
    const run = this.run(requiredChannelId).finally(() => {
      if (this.inFlight !== run) return;
      this.inFlight = undefined;
      if (this.tickAgain && this.live()) {
        this.tickAgain = false;
        void this.tick();
      }
    });
    this.inFlight = run;
    return run;
  }

  /** Waits for the voice line of a game decided in this session, then says how it went. Null for an unknown or skipped game. */
  async outcome(matchId: string): Promise<GameStartOutcome | null> {
    const entry = this.gameStarts.get(matchId);
    if (!entry || entry.status !== "started") return null;
    await entry.voicePromise;
    return {
      textPosted: typeof entry.textChannelId === "string",
      voice: entry.voice === "waiting" || entry.voice === "queued" ? "pending" : entry.voice,
    };
  }

  /** Logs an error once per kind until a check works again, so a Riot outage does not repeat every 20 seconds. */
  private logOnce(error: unknown, context: string): void {
    const key = errorKey(error);
    if (this.loggedErrors.has(key)) return;
    this.loggedErrors.add(key);
    this.dependencies.log(new Error(`${context}: ${errorMessage(error)} (logged once until a check works again)`));
  }

  /** A check answered after failures were logged: say so once, so a stuck watcher and a recovered one look different. */
  private recovered(): void {
    if (this.loggedErrors.size === 0) return;
    this.dependencies.info(`Game start checks work again after ${[...this.loggedErrors].join(", ")} failures.`);
    this.loggedErrors.clear();
  }

  /** One tick. It never rejects: the timer fires it without waiting, so anything unexpected is logged and counted instead. */
  private async run(requiredChannelId?: string): Promise<GameStartTickResult> {
    const result: GameStartTickResult = { started: 0, posted: 0, errors: 0 };
    try {
      await this.check(result, requiredChannelId);
    } catch (error) {
      result.errors++;
      if (this.live()) this.logOnce(error, "A game start check broke off");
    }
    return result;
  }

  /** Drops what the guild's memory no longer needs: check times past the interval, and 锦囊 older than the memory. */
  private forget(now: number): void {
    const { checked, announced, picks } = this.host.memory;
    for (const [puuid, at] of checked) if (now - at >= GAME_START_INTERVAL_MS) checked.delete(puuid);
    for (const [matchId, at] of announced) if (now - at >= ANNOUNCED_MEMORY_MS) announced.delete(matchId);
    for (const [matchId, pick] of picks) if (now - pick.at >= PICK_MEMORY_MS) picks.delete(matchId);
  }

  private async check(result: GameStartTickResult, requiredChannelId?: string): Promise<void> {
    const tick = ++this.ticks;
    const startedAt = this.now();
    this.forget(startedAt);
    const members = this.dependencies.members(this.host.guildId);
    this.prune(members);
    const mock = this.dependencies.mock();
    // Present accounts in bind order, once per PUUID. Saved mock accounts are skipped silently in real mode;
    // the match poll already warns about them.
    const accounts: Array<{ puuid: string; owner: string }> = [];
    for (const member of members) {
      if (!this.host.isPresent(member.discordUserId)) continue;
      for (const account of member.accounts) {
        if (accounts.some((entry) => entry.puuid === account.puuid)) continue;
        if (!mock && account.puuid.startsWith("MOCK-")) continue;
        accounts.push({ puuid: account.puuid, owner: member.discordUserId });
      }
    }
    // Games found in this tick by the accounts they contain, so a premade costs one request.
    const seen = new Map<string, ActiveGame>();
    for (const { puuid, owner } of accounts) {
      if (!this.live()) return;
      let presence = this.accounts.get(puuid);
      if (!presence) {
        presence = { owner, state: { kind: "unknown" } };
        this.accounts.set(puuid, presence);
      }
      const shared = seen.get(puuid);
      if (shared) {
        if (this.observe(presence, puuid, shared, tick, requiredChannelId)) result.started++;
        continue;
      }
      const { state } = presence;
      // A game whose finished match is known is over: the account may already be in the next one, so it is due once now.
      // If Riot still lists the old game at that check, the normal cadence resumes.
      if (state.kind === "inGame" && tick - state.checkedTick < IN_GAME_RECHECK_TICKS
        && (state.sawFinished || !this.host.finished(state.matchId))) continue;
      // The hard budget: an account is asked at most once per interval, counted across sessions of the guild,
      // so an early check for a member who joins, leaves and rejoins never adds requests.
      const asked = this.host.memory.checked.get(puuid);
      if (asked !== undefined && startedAt - asked < GAME_START_INTERVAL_MS) continue;
      this.host.memory.checked.set(puuid, startedAt);
      let game: ActiveGame | null;
      try {
        game = await this.dependencies.activeGame(puuid);
      } catch (error) {
        if (!this.live()) return;
        if (isSpectatorAuthError(error)) {
          // The key cannot use spectator: stop asking for this session. Match monitoring goes on.
          this.disabled = true;
          this.stop();
          result.errors++;
          this.dependencies.log(new Error(`Riot rejected the key for spectator (${errorMessage(error)}), so game start checks are off `
            + "for this monitoring session. Finished matches are still announced."));
          return;
        }
        // A rate limit only skips this account for this tick; it is expected and stays quiet.
        if (error instanceof RiotApiError && error.code === "rate_limited") continue;
        // Anything else, including a 404 that is not "not in a game", is a failed check: the state stays as it was.
        result.errors++;
        this.logOnce(error, "Riot did not say whether an account is in a game");
        continue;
      }
      this.recovered();
      // The member may have left, rejoined or been unbound while Riot answered.
      if (!this.live() || this.accounts.get(puuid) !== presence) continue;
      if (!game) {
        presence.state = { kind: "notInGame" };
        this.releaseRankStarts(puuid);
        continue;
      }
      for (const participant of game.participants) if (participant.puuid) seen.set(participant.puuid, game);
      if (this.observe(presence, puuid, game, tick, requiredChannelId)) result.started++;
    }
    await this.deliverPending(result, requiredChannelId);
  }

  /**
   * One account was seen in a game. Returns true when this decided to announce it:
   * the game is still loading, or this account was not in this game at its previous check in this presence
   * (no game then, or another game: a quick requeue found by the in-game recheck) and the game is at most a minute old.
   */
  private observe(presence: AccountPresence, puuid: string, game: ActiveGame, tick: number, requiredChannelId?: string): boolean {
    const matchId = matchIdOf(game);
    const { state } = presence;
    const notInThisGame = state.kind === "notInGame" || (state.kind === "inGame" && state.matchId !== matchId);
    presence.state = { kind: "inGame", gameId: game.gameId, matchId, checkedTick: tick, sawFinished: this.host.finished(matchId) };
    const known = this.gameStarts.get(matchId);
    // LP does not move during a game, so its start, announced or skipped, is the best before-value; it absorbs a
    // dodge or decay since the last read. A read that failed or was skipped is tried again on the later in-game rechecks.
    this.readRankStart(game, matchId, puuid, !known);
    if (known?.status === "started") return false;
    const fresh = isLoading(game) || (notInThisGame && game.gameLength <= FRESH_GAME_SECONDS);
    const reason = !isAnnouncedGame(game) ? `queue ${game.gameQueueConfigId ?? "unknown"} on map ${game.mapId ?? "unknown"} is not announced`
      : this.host.finished(matchId) ? "it has already finished"
        : this.host.memory.announced.has(matchId) ? "its 锦囊 already went out in an earlier monitoring session"
          : !fresh ? `it was already ${Math.max(0, Math.round(game.gameLength))} s in` : null;
    if (reason) {
      if (!known) {
        this.remember({ matchId, status: "skipped", game, detectedAt: this.now(), voice: "dropped" });
        this.dependencies.info(`Game ${matchId} is not announced at its start: ${reason}.`);
      }
      return false;
    }
    this.remember({ matchId, status: "started", game, detectedAt: this.now(), voice: "waiting", requiredChannelId });
    this.dependencies.info(`Detected game start ${matchId}: ${isLoading(game) ? "loading" : `${Math.round(game.gameLength)} s in`}, `
      + `queue ${game.gameQueueConfigId}.`);
    return true;
  }

  /**
   * Reads the rank of every bound player of a ranked game, both teams, as the before-value of the game's LP row.
   * The first sighting remembers its time, and every later sighting (the in-game rechecks) asks again for the players
   * who still have no successful read from that time on, so a timeout or a 429 at the start does not leave an older read
   * as the before-value, which would count a dodge or decay as part of the game. The tracker's own floor paces the retries,
   * and a player is asked at most 1 + RANK_START_RETRIES times per game; a player who never got a read is shown as
   * unattributable by the tracker, which is told the first sighting.
   * A game whose finished match is already known is over and reads nothing. A failure is logged and changes nothing else.
   */
  private readRankStart(game: ActiveGame, matchId: string, observer: string, first: boolean): void {
    const rank = this.dependencies.rank;
    if (!rank || game.gameQueueConfigId === null || !rankedQueueFor(game.gameQueueConfigId)) return;
    if (this.host.finished(matchId)) {
      this.rankStarts.delete(matchId);
      return;
    }
    if (first) {
      this.rankStarts.delete(matchId);
      this.rankStarts.set(matchId, { since: this.now(), attempts: new Map(), observers: new Set() });
      if (this.rankStarts.size > GAME_STARTS_LIMIT) this.rankStarts.delete(this.rankStarts.keys().next().value!);
    }
    const start = this.rankStarts.get(matchId);
    if (!start) return;
    start.observers.add(observer);
    try {
      const members = this.dependencies.members(this.host.guildId);
      const players = liveParticipants(members, boundParticipants(members, game.participants)).map(({ puuid }) => puuid);
      const { hasReadSince } = rank;
      const waiting = players.filter((puuid) => (start.attempts.get(puuid) ?? 0) <= RANK_START_RETRIES
        && !hasReadSince?.call(rank, puuid, start.since));
      for (const puuid of waiting) start.attempts.set(puuid, (start.attempts.get(puuid) ?? 0) + 1);
      if (waiting.length > 0 || first) rank.snapshot(waiting, { matchId, since: start.since });
      // Done once everyone has a read or has used the attempts, or when the tracker cannot say (one attempt per game).
      if (waiting.length === 0 || !hasReadSince) this.rankStarts.delete(matchId);
    } catch (error) {
      this.dependencies.log(new Error(`The LP snapshot of game ${matchId} was skipped: ${errorMessage(error)}`));
    }
  }

  private remember(entry: GameStartEntry): void {
    this.gameStarts.delete(entry.matchId);
    this.gameStarts.set(entry.matchId, entry);
    if (this.gameStarts.size > GAME_STARTS_LIMIT) this.gameStarts.delete(this.gameStarts.keys().next().value!);
  }

  /** Every started game whose text or voice is still due gets a try, within the window. */
  private async deliverPending(result: GameStartTickResult, requiredChannelId?: string): Promise<void> {
    for (const entry of [...this.gameStarts.values()]) {
      if (!this.live()) return;
      if (entry.status !== "started" || entry.voice !== "waiting") continue;
      if (requiredChannelId !== undefined) entry.requiredChannelId = requiredChannelId;
      try {
        await this.deliver(entry, result);
      } catch (error) {
        if (!this.live()) return;
        // A brief that cannot be built is not retried: the next tick would fail the same way.
        entry.voice = "failed";
        result.errors++;
        this.dependencies.log(new Error(`The 军师赛前锦囊 of game ${entry.matchId} failed: ${errorMessage(error)}`));
      }
    }
  }

  private expired(entry: GameStartEntry): boolean {
    return this.now() - entry.detectedAt >= GAME_START_WINDOW_MS;
  }

  /** Bound participants of the game who still own the account they play on. */
  private participants(entry: GameStartEntry): BoundParticipant[] {
    const members = this.dependencies.members(this.host.guildId);
    return liveParticipants(members, boundParticipants(members, entry.game.participants));
  }

  private async deliver(entry: GameStartEntry, result: GameStartTickResult): Promise<void> {
    const { client, guildId } = this.host;
    if (this.host.finished(entry.matchId)) {
      entry.voice = "dropped";
      return;
    }
    if (this.expired(entry)) {
      entry.voice = "dropped";
      this.dependencies.info(`The 军师赛前锦囊 of game ${entry.matchId} was dropped: ${entry.brief ? "its voice line" : "it"} could not start `
        + `within ${GAME_START_WINDOW_MS / 1000} s of the game start.`);
      return;
    }
    const members = this.dependencies.members(guildId);
    const ids = () => liveParticipantIds(this.dependencies.members(guildId), this.participants(entry));
    if (!entry.brief) {
      const participants = this.participants(entry);
      const voiceChannel = chooseChannel(this.dependencies.resolveChannel, client, guildId, ids(), this.host.lastChannelId());
      // With no channel the voice can use, the text still goes to the best channel the players are in, and there is no voice.
      const textResolver = this.dependencies.resolveTextChannel;
      const channel = voiceChannel
        ?? (textResolver ? chooseChannel(textResolver, client, guildId, ids(), this.host.lastChannelId()) : null);
      const textOnly = !voiceChannel;
      // No participant in a usable channel yet: nothing is posted, and the next tick tries again within the window.
      if (!channel || (entry.requiredChannelId !== undefined && channel.id !== entry.requiredChannelId)) return;
      const speaker = perspective(textOnly ? textResolver! : this.dependencies.resolveChannel, client, guildId, this.host.isPresent, participants, channel);
      if (!speaker) return;
      entry.teamId = speaker.teamId;
      entry.brief = this.buildBrief(entry, members, participants, speaker.teamId);
      // From here the 锦囊 is out for this guild: a later session (someone left and rejoined voice) must not repeat it.
      const { announced } = this.host.memory;
      announced.delete(entry.matchId);
      announced.set(entry.matchId, this.now());
      if (announced.size > GAME_STARTS_LIMIT) announced.delete(announced.keys().next().value!);
      if (entry.brief.pick) {
        entry.pickMemberId = entry.brief.pick.memberId;
        entry.pickPuuid = participants.find((participant) => participant.memberId === entry.brief!.pick!.memberId
          && participant.teamId === speaker.teamId)?.puuid;
      }
      // Text first, fixed now; a failed post is logged and the voice still plays.
      const mentions = ids().filter((memberId) => channel.members.has(memberId));
      try {
        await channel.send({
          ...(mentions.length > 0 ? { content: pregameMentionContent(mentions) } : {}),
          embeds: [buildPregameEmbed(entry.brief)],
          allowedMentions: pregameAllowedMentions(mentions),
        });
        entry.textChannelId = channel.id;
        this.rememberShownPick(entry);
        result.posted++;
        this.dependencies.info(`Posted the 军师赛前锦囊 of game ${entry.matchId} in ${(channel as { name?: string }).name ?? channel.id}.`);
      } catch (error) {
        entry.textChannelId = null;
        result.errors++;
        this.dependencies.log(new Error(`The 军师赛前锦囊 text of game ${entry.matchId} was not posted: ${errorMessage(error)}`));
      }
      if (!this.live()) return;
      this.host.rememberChannel(channel.id);
      if (textOnly) {
        // Not a failure: nobody could have heard it.
        entry.voice = "dropped";
        this.dependencies.info(`The 军师赛前锦囊 of game ${entry.matchId} is text only: no player is in a voice channel the bot can join and speak in.`);
        return;
      }
    }
    if (!this.dependencies.pregameVoice(guildId)) {
      entry.voice = "off";
      return;
    }
    this.queueVoice(entry);
  }

  /**
   * Keeps the 军师之选 for the 锦囊回顾, but only once somebody could see or hear the card: its text was posted, or its voice line started.
   * A pick nobody saw is never recapped. Outlives the 15 minute memory: the finished report of a long game may want it hours later.
   */
  private rememberShownPick(entry: GameStartEntry): void {
    if (!entry.brief || !entry.pickMemberId || !entry.pickPuuid) return;
    rememberPick(this.host.memory, entry.matchId, { memberId: entry.pickMemberId, puuid: entry.pickPuuid, mock: entry.brief.mock, at: this.now() });
  }

  /** Only bound members on the perspective team reach the builder; everyone else on that team is a count, the other team nothing. */
  private buildBrief(entry: GameStartEntry, members: readonly TrackedMember[], participants: readonly BoundParticipant[], teamId: number): PregameBrief {
    const mock = this.dependencies.mock();
    const ours = participants.filter((participant) => participant.teamId === teamId);
    const teammates: PregameTeammate[] = [];
    for (const participant of ours) {
      if (teammates.some((teammate) => teammate.memberId === participant.memberId)) continue;
      const player = entry.game.participants.find((candidate) => candidate.puuid === participant.puuid)!;
      const account = members.find((member) => member.discordUserId === participant.memberId)!
        .accounts.find((candidate) => candidate.puuid === participant.puuid)!;
      teammates.push({
        memberId: participant.memberId,
        // Our stored game name, never the spectator riotId.
        storedGameName: account.gameName,
        championId: player.championId,
        smite: player.spell1Id === SMITE || player.spell2Id === SMITE,
        records: this.dependencies.records(this.host.guildId, participant.memberId, mock),
      });
    }
    const boundPuuids = new Set(participants.map((participant) => participant.puuid));
    const strangerCount = entry.game.participants
      .filter((player) => player.teamId === teamId && !player.bot && !(player.puuid && boundPuuids.has(player.puuid))).length;
    return buildPregameBrief({
      matchId: entry.matchId,
      mock,
      teammates,
      strangerCount,
      otherSideHasFriend: participants.some((participant) => participant.teamId !== teamId),
    });
  }

  /**
   * Queues the voice line once. Before it plays it needs the window, an unfinished match and a teammate of the rated team in voice;
   * a cancellation before playback leaves it for the next tick within the window. Once playing, the line finishes.
   */
  private queueVoice(entry: GameStartEntry): void {
    const { client, guildId } = this.host;
    const brief = entry.brief!;
    const ids = () => liveParticipantIds(this.dependencies.members(guildId), this.participants(entry));
    let pick: string | undefined = this.host.lastChannelId();
    let playing: VoiceChannel | undefined;
    let resolves = 0;
    const resolveTarget = (): VoiceChannel | null => {
      // Once playing, the line stays where it started; it is about 15 seconds.
      if (playing) return playing;
      const chosen = chooseChannel(this.dependencies.resolveChannel, client, guildId, ids(), pick);
      if (!chosen) return null;
      pick = chosen.id;
      if (entry.requiredChannelId !== undefined && chosen.id !== entry.requiredChannelId) return null;
      return chosen;
    };
    const resolveForQueue = () => {
      const target = resolveTarget();
      // The queue resolves once before generation and once when joining; from the second call on the line is playing.
      if (++resolves >= 2 && target && !playing) {
        playing = target;
        this.rememberShownPick(entry);
        this.host.rememberChannel(target.id);
        this.dependencies.info(`The 军师赛前锦囊 of game ${entry.matchId} starts playing ${((this.now() - entry.detectedAt) / 1000).toFixed(1)} s `
          + "after detection.");
      }
      return target;
    };
    const teammatePresent = () => this.participants(entry)
      .some((participant) => participant.teamId === entry.teamId && this.host.isPresent(participant.memberId));
    const canPlay = () => {
      if (!this.host.current()) return false;
      if (playing) return true;
      return !this.expired(entry) && !this.host.finished(entry.matchId) && teammatePresent() && Boolean(resolveTarget());
    };
    entry.voice = "queued";
    entry.voicePromise = this.dependencies.announce(guildId, brief.speech, this.dependencies.voiceStyle(guildId), resolveForQueue, canPlay, this.host.signal)
      .then(() => {
        entry.voice = "played";
        this.dependencies.info(`Spoke the 军师赛前锦囊 of game ${entry.matchId} ${((this.now() - entry.detectedAt) / 1000).toFixed(1)} s after detection.`);
      }, (error: unknown) => {
        if ((error instanceof AnnouncementCancelledError || error instanceof AnnouncementQueueFullError) && !playing) {
          // Nothing was heard: the next tick may try again while the window lasts.
          entry.voice = "waiting";
          return;
        }
        if (error instanceof AnnouncementCancelledError) {
          entry.voice = "dropped";
          return;
        }
        // The text is already there; a failed line is not retried.
        entry.voice = "failed";
        this.dependencies.log(new Error(`The 军师赛前锦囊 voice line of game ${entry.matchId} failed: ${errorMessage(error)}`));
      });
  }
}
