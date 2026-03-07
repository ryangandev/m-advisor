import fs from "node:fs";
import { spawn } from "node:child_process";
import { Client, VoiceChannel } from "discord.js";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import ffmpegStatic from "ffmpeg-static";
import { getBinding } from "../store/bindingStore";
import {
  getAnnouncerState,
  getLastMatchId,
  setActiveVoiceChannel,
  setLastMatchId,
  setPollingInterval,
} from "../store/announcerStore";
import { getBestAndWorst, getLatestSRMatchId, getMatchDetail } from "../utils/riotMatchApi";
import { generateTTS } from "../utils/tts";

const POLL_INTERVAL_MS = 45_000;

export function startPolling(client: Client, guildId: string, voiceChannelId: string): void {
  const state = getAnnouncerState(guildId);
  setActiveVoiceChannel(guildId, voiceChannelId);

  if (state.pollingInterval) {
    return;
  }

  void pollAndAnnounce(client, guildId);

  const interval = setInterval(() => {
    void pollAndAnnounce(client, guildId);
  }, POLL_INTERVAL_MS);

  setPollingInterval(guildId, interval);
}

export function stopPolling(guildId: string): void {
  const state = getAnnouncerState(guildId);
  if (!state.pollingInterval) {
    return;
  }

  clearInterval(state.pollingInterval);
  setPollingInterval(guildId, null);
}

async function pollAndAnnounce(client: Client, guildId: string): Promise<void> {
  try {
    const binding = getBinding(guildId);
    if (!binding) {
      stopPolling(guildId);
      return;
    }

    for (const account of binding.accounts) {
      try {
        const matchId = await getLatestSRMatchId(account.puuid);
        const previousMatchId = getLastMatchId(guildId, account.puuid);

        if (!matchId || matchId === previousMatchId) {
          continue;
        }

        setLastMatchId(guildId, account.puuid, matchId);

        const detail = await getMatchDetail(matchId);
        const participants = detail.info.participants.map((participant) => ({
          puuid: participant.puuid,
          summonerName: participant.riotIdGameName || "Unknown",
          kills: participant.kills,
          deaths: participant.deaths,
          assists: participant.assists,
          win: participant.win,
          teamId: participant.teamId,
        }));

        const { best, worst } = getBestAndWorst(participants);

        const announcerState = getAnnouncerState(guildId);
        const voiceChannelId = announcerState.activeVoiceChannelId;

        if (!voiceChannelId) {
          continue;
        }

        const win = best.win ? "Victory" : "Defeat";
        const text = `${win}! Best player: ${best.summonerName}, with ${best.kills} kills, ${best.deaths} deaths, and ${best.assists} assists. Worst player: ${worst.summonerName}, with ${worst.kills} kills, ${worst.deaths} deaths, and ${worst.assists} assists.`;

        await announce(client, guildId, voiceChannelId, text);
      } catch (error) {
        console.error("Polling account failed:", error);
      }
    }
  } catch (error) {
    console.error("Polling loop failed:", error);
  }
}

async function announce(
  client: Client,
  guildId: string,
  voiceChannelId: string,
  text: string,
): Promise<void> {
  const channel = client.channels.cache.get(voiceChannelId);
  if (!channel || !(channel instanceof VoiceChannel)) {
    return;
  }

  // Generate TTS BEFORE joining VC — execSync blocks the event loop,
  // which can drop the voice connection if called after joining
  const style = getAnnouncerState(guildId).voiceStyle;
  let ttsPath: string | null = null;
  try {
    ttsPath = generateTTS(text, style);
  } catch (error) {
    console.error("TTS generation failed:", error);
    return;
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannelId,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });

  let ffmpegProcess: ReturnType<typeof spawn> | null = null;

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
    console.log("[announce] Connection ready, playing TTS immediately");

    const player = createAudioPlayer();
    connection.on("stateChange", (o, n) => {
      console.log(`[Connection] ${o.status} -> ${n.status}`);
    });
    player.on("stateChange", (o, n) => {
      console.log(`[Player] ${o.status} -> ${n.status}`);
    });
    player.on("error", (e) => {
      console.error("[Player error]", e.message, e.stack);
    });

    const ffmpegPath = ffmpegStatic ?? "ffmpeg";
    ffmpegProcess = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        ttsPath,
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    ffmpegProcess.stderr?.on("data", (d) => console.log("[ffmpeg]", d.toString()));

    const resource = createAudioResource(ffmpegProcess.stdout!, {
      inputType: StreamType.Raw,
    });
    connection.subscribe(player);
    player.play(resource);

    await entersState(player, AudioPlayerStatus.Idle, 60_000);
  } catch (error) {
    console.error("Voice announcement failed:", error);
  } finally {
    connection.destroy();
    if (ffmpegProcess && !ffmpegProcess.killed) {
      ffmpegProcess.kill("SIGKILL");
    }

    if (ttsPath && fs.existsSync(ttsPath)) {
      try {
        fs.unlinkSync(ttsPath);
      } catch (error) {
        console.error("Failed to clean up TTS file:", error);
      }
    }
  }
}
