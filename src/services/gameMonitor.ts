import { existsSync, unlinkSync } from "node:fs";
import { Client, VoiceChannel } from "discord.js";
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
import { playMp3InVoiceChannel } from "../utils/voicePlayback";

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

  // Generate TTS before joining VC so the connection is only opened when audio is ready.
  const style = getAnnouncerState(guildId).voiceStyle;
  let ttsPath: string | null = null;
  try {
    ttsPath = await generateTTS(text, style);
  } catch (error) {
    console.error("TTS generation failed:", error);
    return;
  }

  try {
    await playMp3InVoiceChannel(channel, ttsPath, 60_000);
  } catch (error) {
    console.error("Voice announcement failed:", error);
  } finally {
    if (ttsPath && existsSync(ttsPath)) {
      try {
        unlinkSync(ttsPath);
      } catch (error) {
        console.error("Failed to clean up TTS file:", error);
      }
    }
  }
}
