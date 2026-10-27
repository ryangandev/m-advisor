import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { BotCommand } from "../types";
import { listTrackedMembers } from "../store/bindingStore";
import { getRiotMode, RiotApiError, simulateMockGameStart, simulateMockMatch } from "../services/riotData";
import { pollGameStartNow, pollGuildNow } from "../services/gameMonitor";
import { reconcileGuildMonitoring } from "../services/monitorLifecycle";
import { getAuthorizedTestChannel, safeTestError } from "../utils/testChannel";
import { withSimulationLock } from "../services/simulationLock";
import { getLastMatchId } from "../store/announcerStore";
import { assertRunning } from "../services/shutdownState";
import { logError } from "../utils/log";
import { NO_MENTIONS } from "../utils/embeds";

/** A mock game holds at most five accounts on one team. */
const TEAM_SIZE = 5;
const FAILED = "模拟比赛暂未播报成功，请稍后重试或查看本地日志。";

const command: BotCommand = {
  data: new SlashCommandBuilder().setName("simulate").setDescription("用模拟比赛验证完整赛后播报流程")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName("outcome").setDescription("模拟赛果").setRequired(true)
      .addChoices({ name: "胜利", value: "win" }, { name: "失败", value: "loss" }, { name: "开局（赛前锦囊）", value: "start" })) as SlashCommandBuilder,
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      assertRunning();
      const channel = await getAuthorizedTestChannel(interaction);
      assertRunning();
      await withSimulationLock(channel.guild.id, async () => {
        assertRunning();
        if (getRiotMode() !== "mock") throw new Error("模拟比赛只允许在 RIOT_MODE=mock 时使用。");
        const tracked = listTrackedMembers(channel.guild.id);
        if (tracked.length === 0) throw new Error("请先使用 /bind 绑定一个测试账号，例如 MockWin#NA1。");
        const states = await Promise.all(tracked.map((member) =>
          channel.guild.members.fetch(member.discordUserId).catch(() => null)));
        assertRunning();
        const inChannel = tracked.filter((_, index) => states[index]?.voice.channelId === channel.id);
        // The earliest-bound tracked member in the test channel plays the simulated match on their first account.
        const binding = inChannel[0];
        if (!binding) throw new Error("请先让被追踪成员进入同一个测试语音频道。");
        await reconcileGuildMonitoring(interaction.client, channel.guild.id);
        assertRunning();
        const outcome = interaction.options.getString("outcome", true) as "win" | "loss" | "start";
        if (outcome === "start") {
          // Every tracked member in the test channel joins the mock game on their first account, in bind order.
          const blue = [...new Set(inChannel.map((member) => member.accounts[0].puuid))].slice(0, TEAM_SIZE);
          let game: { matchId: string };
          try {
            game = simulateMockGameStart(blue);
          } catch (error) {
            if (error instanceof RiotApiError && error.code === "bad_request") {
              throw new Error("模拟开局失败：有成员已在一局模拟对局中，请先用 /simulate 胜利或失败结束它。");
            }
            throw error;
          }
          const { outcome: brief } = await pollGameStartNow(channel.guild.id, game.matchId, channel.id);
          assertRunning();
          if (!brief?.textPosted || (brief.voice !== "played" && brief.voice !== "off")) throw new Error("模拟锦囊暂未发出，请稍后重试或查看本地日志。");
          const content = brief.voice === "played"
            ? "模拟数据：军师赛前锦囊已发到文字频道并播报完成。此结果不是实际战绩。"
            : "模拟数据：军师赛前锦囊已发到文字频道；本服务器关闭了赛前语音。此结果不是实际战绩。";
          await interaction.editReply({ content, allowedMentions: NO_MENTIONS });
          return;
        }
        const baseline = await pollGuildNow(interaction.client, channel.guild.id, channel.id);
        assertRunning();
        if (baseline.errors > 0) throw new Error(FAILED);
        const simulated = simulateMockMatch(binding.accounts[0].puuid, outcome);
        const result = await pollGuildNow(interaction.client, channel.guild.id, channel.id);
        assertRunning();
        if (result.announced < 1 || result.errors > 0 || getLastMatchId(channel.guild.id, binding.accounts[0].puuid) !== simulated.matchId) throw new Error(FAILED);
        await interaction.editReply({ content: `模拟数据：${outcome === "win" ? "胜利" : "失败"}比赛播报完成。此结果不是实际战绩。`, allowedMentions: NO_MENTIONS });
      });
    } catch (error) {
      logError(`Simulation test failed: ${error instanceof Error ? error.name : "unknown error"}`);
      await interaction.editReply({ content: safeTestError(error), allowedMentions: NO_MENTIONS });
    }
  },
};
export default command;
