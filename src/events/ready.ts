import { Events } from "discord.js";
import { restoreMonitoring } from "../services/monitorLifecycle";
import { getRiotDataLabel } from "../services/riotData";
import { prewarmTTS } from "../utils/tts";
import { isStopping } from "../services/shutdownState";
import { logError, logInfo } from "../utils/log";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client: import("discord.js").Client): Promise<void> {
    if (isStopping()) return;
    const tag = client.user?.tag ?? "unknown-user";
    logInfo(`Logged in as ${tag}; data: ${getRiotDataLabel()}`);
    await restoreMonitoring(client);
    if (isStopping()) return;
    logInfo("Preparing speech provider; first local model load can take several minutes.");
    void prewarmTTS().then(() => logInfo("Speech provider ready.")).catch((error: unknown) => {
      logError(`Speech preparation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  },
};
