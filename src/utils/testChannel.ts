import { ChatInputCommandInteraction, PermissionFlagsBits, VoiceChannel } from "discord.js";

export async function getAuthorizedTestChannel(interaction: ChatInputCommandInteraction): Promise<VoiceChannel> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    throw new Error("测试命令需要服务器管理员权限。");
  }
  const guildId = process.env.TEST_GUILD_ID?.trim();
  if (!guildId || interaction.guildId !== guildId || !interaction.guild) {
    throw new Error("请先配置 TEST_GUILD_ID；测试命令只允许在该服务器使用。");
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!(channel instanceof VoiceChannel)) {
    throw new Error("请先进入一个普通语音频道，再运行测试命令。");
  }
  const configuredChannel = process.env.TEST_VOICE_CHANNEL_ID?.trim();
  if (configuredChannel && channel.id !== configuredChannel) {
    throw new Error("请进入配置的测试语音频道后再试。");
  }
  const permissions = channel.permissionsFor(interaction.client.user!);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error("Bot 在这个频道需要 View Channel、Connect 和 Speak 权限。");
  }
  return channel;
}

export function safeTestError(error: unknown): string {
  const message = error instanceof Error ? error.message : "测试失败。";
  if (/^(测试命令|请先|请进入|Bot 在|当前|模拟)/.test(message)) return message;
  return "测试失败，请查看本地诊断日志；可检查语音模型、频道权限和网络连接。";
}
