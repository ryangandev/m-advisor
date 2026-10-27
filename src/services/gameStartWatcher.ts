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

/** How often present members' accounts are asked whether they are in a game. */
export const GAME_START_INTERVAL_MS = 20_000;
/** An account already seen in a game is asked again only every this many ticks (2 minutes), until it is out of it. */
export const IN_GAME_RECHECK_TICKS = 6;
/** A line that has not started playing this long after detection is dropped: the loading screen is over by then. */
export const GAME_START_WINDOW_MS = 90_000;
/** A game seen by an account whose previous check found no game is announced while it has run at most this long. */
export const FRESH_GAME_SECONDS = 60;
/** At most this many games are remembered per session; the oldest is forgotten first. */
const GAME_STARTS_LIMIT = 50;
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
}

/** Where an account stands in the current presence of its member. */
type PresenceState =
  | { kind: "unknown" }
  | { kind: "notInGame" }
  | { kind: "inGame"; gameId: number; checkedTick: number };

interface AccountPresence {
  /** The member who owned the account when the watcher first saw it; another owner means a fresh presence. */
  owner: string;
  state: PresenceState;
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
  private readonly loggedErrors = new Set<string>();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<GameStartTickResult>;
  private tickAgain = false;
  private ticks = 0;
  private disabled = false;

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
    this.timer = setInterval(() => { void this.tick(); }, GAME_START_INTERVAL_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
    const before = new Set(this.accounts.keys());
    this.prune(members);
    const joined = members.some((member) => this.host.isPresent(member.discordUserId)
      && member.accounts.some((account) => !before.has(account.puuid)));
    if (joined && this.timer) this.tickSoon();
  }

  /** An account whose member left voice, was unbound or lost it starts over as unknown when it comes back. */
  prune(members = this.dependencies.members(this.host.guildId)): void {
    const owners = new Map<string, string>();
    for (const member of members) {
      if (!this.host.isPresent(member.discordUserId)) continue;
      for (const account of member.accounts) if (!owners.has(account.puuid)) owners.set(account.puuid, member.discordUserId);
    }
    for (const [puuid, presence] of this.accounts) if (owners.get(puuid) !== presence.owner) this.accounts.delete(puuid);
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

  /** Logs an error once per session and kind, so a Riot outage does not repeat every 20 seconds. */
  private logOnce(error: unknown, context: string): void {
    const key = errorKey(error);
    if (this.loggedErrors.has(key)) return;
    this.loggedErrors.add(key);
    this.dependencies.log(new Error(`${context}: ${errorMessage(error)} (logged once per monitoring session)`));
  }

  private async run(requiredChannelId?: string): Promise<GameStartTickResult> {
    const result: GameStartTickResult = { started: 0, posted: 0, errors: 0 };
    const tick = ++this.ticks;
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
      if (!this.live()) return result;
      let presence = this.accounts.get(puuid);
      if (!presence) {
        presence = { owner, state: { kind: "unknown" } };
        this.accounts.set(puuid, presence);
      }
      const shared = seen.get(puuid);
      if (shared) {
        if (this.observe(presence, shared, tick, requiredChannelId)) result.started++;
        continue;
      }
      const { state } = presence;
      if (state.kind === "inGame" && tick - state.checkedTick < IN_GAME_RECHECK_TICKS) continue;
      let game: ActiveGame | null;
      try {
        game = await this.dependencies.activeGame(puuid);
      } catch (error) {
        if (!this.live()) return result;
        if (isSpectatorAuthError(error)) {
          // The key cannot use spectator: stop asking for this session. Match monitoring goes on.
          this.disabled = true;
          this.stop();
          result.errors++;
          this.dependencies.log(new Error(`Game start checks are off for this monitoring session: Riot rejected the key for spectator `
            + `(${errorMessage(error)}). Finished matches are still announced.`));
          return result;
        }
        // A rate limit only skips this account for this tick; it is expected and stays quiet.
        if (error instanceof RiotApiError && error.code === "rate_limited") continue;
        // Anything else, including a 404 that is not "not in a game", is a failed check: the state stays as it was.
        result.errors++;
        this.logOnce(error, "A game start check failed");
        continue;
      }
      // The member may have left, rejoined or been unbound while Riot answered.
      if (!this.live() || this.accounts.get(puuid) !== presence) continue;
      if (!game) {
        presence.state = { kind: "notInGame" };
        continue;
      }
      for (const participant of game.participants) if (participant.puuid) seen.set(participant.puuid, game);
      if (this.observe(presence, game, tick, requiredChannelId)) result.started++;
    }
    await this.deliverPending(result, requiredChannelId);
    return result;
  }

  /**
   * One account was seen in a game. Returns true when this decided to announce it:
   * the game is still loading, or this account's previous check in this presence found no game and the game is at most a minute old.
   */
  private observe(presence: AccountPresence, game: ActiveGame, tick: number, requiredChannelId?: string): boolean {
    const previous = presence.state.kind;
    presence.state = { kind: "inGame", gameId: game.gameId, checkedTick: tick };
    const matchId = matchIdOf(game);
    const known = this.gameStarts.get(matchId);
    if (known?.status === "started") return false;
    const fresh = isLoading(game) || (previous === "notInGame" && game.gameLength <= FRESH_GAME_SECONDS);
    const reason = !isAnnouncedGame(game) ? `queue ${game.gameQueueConfigId ?? "unknown"} on map ${game.mapId ?? "unknown"} is not announced`
      : this.host.finished(matchId) ? "it has already finished"
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
      const channel = chooseChannel(this.dependencies.resolveChannel, client, guildId, ids(), this.host.lastChannelId());
      // No participant in a usable channel yet: nothing is posted, and the next tick tries again within the window.
      if (!channel || (entry.requiredChannelId !== undefined && channel.id !== entry.requiredChannelId)) return;
      const speaker = perspective(this.dependencies.resolveChannel, client, guildId, this.host.isPresent, participants, channel);
      if (!speaker) return;
      entry.teamId = speaker.teamId;
      entry.brief = this.buildBrief(entry, members, participants, speaker.teamId);
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
        result.posted++;
        this.dependencies.info(`Posted the 军师赛前锦囊 of game ${entry.matchId} in ${(channel as { name?: string }).name ?? channel.id}.`);
      } catch (error) {
        entry.textChannelId = null;
        result.errors++;
        this.dependencies.log(new Error(`The 军师赛前锦囊 text of game ${entry.matchId} was not posted: ${errorMessage(error)}`));
      }
      if (!this.live()) return;
      this.host.rememberChannel(channel.id);
    }
    if (!this.dependencies.pregameVoice(guildId)) {
      entry.voice = "off";
      return;
    }
    this.queueVoice(entry);
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
