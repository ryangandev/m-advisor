import dotenv from 'dotenv';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import { execSync, spawn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

dotenv.config();

const TARGET_USER_ID = '386959106994601994';
const GUILD_ID = '1048644967171625020';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', async () => {
  console.log('Bot ready');

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { console.error('Guild not found'); process.exit(1); }

  await guild.members.fetch();
  const member = guild.members.cache.get(TARGET_USER_ID);
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) { console.error('User not in VC'); process.exit(1); }
  console.log(`Joining #${voiceChannel.name} (${voiceChannel.id})`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: GUILD_ID,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  // Log every state change
  connection.on('stateChange', (oldState, newState) => {
    console.log(`Connection: ${oldState.status} → ${newState.status}`);
  });

  connection.on('error', (err) => {
    console.error('Connection error:', err.message);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (e) {
    console.error('Failed to reach Ready state:', e.message);
    connection.destroy();
    process.exit(1);
  }

  console.log('Connected! Generating TTS...');
  const text = 'Victory! Best player: not ry, with 8 kills, 2 deaths, and 5 assists.';
  const aiffPath = join(tmpdir(), `test-${Date.now()}.aiff`);
  execSync(`say -v Samantha -o "${aiffPath}" "${text}"`);

  const ffmpeg = spawn('ffmpeg', ['-i', aiffPath, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  const player = createAudioPlayer();
  player.on('stateChange', (o, n) => console.log(`Player: ${o.status} → ${n.status}`));
  player.on('error', e => console.error('Player error:', e.message));

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  connection.subscribe(player);
  player.play(resource);

  try {
    await entersState(player, AudioPlayerStatus.Idle, 30000);
    console.log('Done!');
  } catch (e) {
    console.error('Playback failed:', e.message);
  } finally {
    connection.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
