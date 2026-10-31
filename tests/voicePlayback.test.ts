import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { test } from "node:test";
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState,
  type AudioResource, type CreateAudioPlayerOptions,
} from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import {
  PCM_FRAME_BYTES, SENTENCE_PAUSE_MS, createVoicePlayback, decodeSpeechFile, prepareSpeechPcm, type VoicePlaybackDependencies,
} from "../src/utils/voicePlayback";

class FakeStateMachine extends EventEmitter {
  state: { status: string };
  constructor(status: string) { super(); this.state = { status }; }
  transition(status: string) {
    const previous = this.state;
    this.state = { status };
    this.emit("stateChange", previous, this.state);
    this.emit(status, this.state);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

/** Constant PCM whose length is a whole number of stereo frames. */
const pcm = (frames: number, value = 1000) => {
  const buffer = Buffer.alloc(frames * 4);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(value, offset);
  return buffer;
};

async function* chunks(...paths: string[]) {
  for (const file of paths) yield file;
}

function transport() {
  const connection = new FakeStateMachine(VoiceConnectionStatus.Signalling) as FakeStateMachine & {
    subscribe: () => unknown; destroy: () => void; joinConfig: { channelId: string };
  };
  connection.joinConfig = { channelId: "voice" };
  let connectionDestroyed = 0;
  let playerStopped = 0;
  let joins = 0;
  let plays = 0;
  let input: Readable | undefined;
  let playerOptions: CreateAudioPlayerOptions | undefined;
  let inputType: StreamType | undefined;
  const received: Buffer[] = [];
  const decoded: string[] = [];
  let decode: (file: string) => Promise<Buffer> = async (file) => { decoded.push(file); return pcm(960); };
  const encoder = new PassThrough();
  const player = new FakeStateMachine(AudioPlayerStatus.Idle) as FakeStateMachine & {
    play: (resource: AudioResource) => void; stop: () => void;
  };
  // Like the real player: Playing once audio flows, Idle once the resource's stream ends.
  let onPlay = () => {
    queueMicrotask(() => {
      player.transition(AudioPlayerStatus.Playing);
      input!.on("data", (chunk: Buffer) => received.push(chunk));
      input!.once("end", () => setImmediate(() => player.transition(AudioPlayerStatus.Idle)));
    });
  };
  connection.subscribe = () => ({});
  connection.destroy = () => { connectionDestroyed++; connection.transition(VoiceConnectionStatus.Destroyed); };
  player.play = () => { plays++; onPlay(); };
  player.stop = () => { playerStopped++; player.transition(AudioPlayerStatus.Idle); };
  const statuses: string[] = [];
  const dependencies = {
    join: () => { joins++; queueMicrotask(() => connection.transition(VoiceConnectionStatus.Ready)); return connection; },
    createPlayer: (options: CreateAudioPlayerOptions) => { playerOptions = options; return player; },
    createResource: (stream: Readable, options: { inputType: StreamType }) => {
      input = stream;
      inputType = options.inputType;
      return { playStream: encoder };
    },
    enter: (target: Parameters<typeof entersState>[0], status: Parameters<typeof entersState>[1], signal: AbortSignal) => {
      statuses.push(status);
      return entersState(target, status, signal);
    },
    decode: (file: string) => decode(file),
  } as unknown as VoicePlaybackDependencies;
  const channel = { id: "voice", guild: { id: "guild", voiceAdapterCreator: () => undefined } } as unknown as VoiceChannel;
  return {
    connection, player, encoder, dependencies, statuses, received, decoded,
    get input() { return input; },
    get inputType() { return inputType; },
    get playerOptions() { return playerOptions; },
    get connectionDestroyed() { return connectionDestroyed; },
    get playerStopped() { return playerStopped; },
    get joins() { return joins; },
    get plays() { return plays; },
    set onPlay(value: () => void) { onPlay = value; },
    set decode(value: (file: string) => Promise<Buffer>) { decode = value; },
    play: (audio: AsyncIterable<string> = chunks("test.wav"), signal?: AbortSignal, timeoutMs = 1000) =>
      createVoicePlayback(dependencies)(channel, audio, timeoutMs, signal),
  };
}

test("voice playback observes Ready, Playing, then Idle and disposes its resources", async () => {
  const voice = transport();
  await voice.play();
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready, AudioPlayerStatus.Playing, AudioPlayerStatus.Idle]);
  assert.equal(voice.playerStopped, 1);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.input!.destroyed, true);
  assert.equal(voice.encoder.destroyed, true);
});

test("chunks play in order through one raw stream with sentence pauses and whole frames", async () => {
  const voice = transport();
  const sizes = new Map([["first.wav", pcm(1000, 1000)], ["second.wav", pcm(500, 2000)], ["third.wav", pcm(960, 3000)]]);
  voice.decode = async (file) => { voice.decoded.push(file); return sizes.get(file)!; };
  await voice.play(chunks("first.wav", "second.wav", "third.wav"));
  assert.deepEqual(voice.decoded, ["first.wav", "second.wav", "third.wav"]);
  assert.equal(voice.joins, 1);
  assert.equal(voice.plays, 1, "one resource carries every chunk");
  assert.equal(voice.inputType, StreamType.Raw);
  const stream = Buffer.concat(voice.received);
  const pause = SENTENCE_PAUSE_MS * 48 * 4;
  const frame = (bytes: number) => Math.ceil(bytes / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
  const firstLength = frame(1000 * 4);
  const secondLength = frame(pause + 500 * 4);
  assert.equal(stream.length, firstLength + secondLength + frame(pause + 960 * 4));
  assert.equal(stream.length % PCM_FRAME_BYTES, 0);
  // Each chunk keeps its own samples, in order, after the pause that precedes it.
  assert.equal(stream.readInt16LE(500 * 4), 1000);
  assert.equal(stream.readInt16LE(firstLength), 0, "pause before the second sentence");
  assert.equal(stream.readInt16LE(firstLength + pause + 250 * 4), 2000);
  assert.equal(stream.readInt16LE(firstLength + secondLength + pause + 480 * 4), 3000);
});

test("a gap while the next chunk generates neither ends playback nor counts as success", async () => {
  const voice = transport();
  const second = deferred<void>();
  let secondRequested = false;
  async function* slow() {
    yield "first.wav";
    secondRequested = true;
    await second.promise;
    yield "second.wav";
  }
  const result = voice.play(slow());
  while (!secondRequested || voice.statuses.length < 3) await new Promise<void>((resolve) => setImmediate(resolve));
  // Playback is already under way while the second sentence is still being generated.
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready, AudioPlayerStatus.Playing, AudioPlayerStatus.Idle]);
  assert.equal(voice.player.state.status, AudioPlayerStatus.Playing);
  assert.equal(voice.playerOptions?.behaviors?.maxMissedFrames, Infinity, "silence fills the gap instead of stopping");
  second.resolve();
  await result;
  assert.deepEqual(voice.decoded, ["first.wav", "second.wav"]);
});

test("a generation failure between chunks rejects with that error and cleans the transport", async () => {
  const voice = transport();
  async function* failing() {
    yield "first.wav";
    throw new Error("Local TTS worker exited.");
  }
  await assert.rejects(voice.play(failing()), /worker exited/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
  assert.notEqual(voice.input?.destroyed, false, "a created stream is destroyed");
});

test("an announcement without audio fails instead of reporting success", async () => {
  const voice = transport();
  await assert.rejects(voice.play(chunks()), /No announcement audio/);
  assert.equal(voice.joins, 0);
});

test("initial Idle never counts as successful playback before audio starts", async () => {
  const voice = transport();
  voice.onPlay = () => setImmediate(() => voice.player.emit("error", new Error("encoder failed before Playing")));
  await assert.rejects(voice.play(), /playback failed|encoder failed/);
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready, AudioPlayerStatus.Playing]);
  assert.equal(voice.connectionDestroyed, 1);
});

test("an unreadable first chunk fails before joining", async () => {
  const voice = transport();
  voice.decode = async () => { throw new Error("missing file"); };
  await assert.rejects(voice.play(), /missing file/);
  assert.equal(voice.joins, 0, "a corrupt first chunk never causes a brief join");
  assert.equal(voice.plays, 0);
});

test("the first chunk is decoded before joining and a later decode error cleans the transport", async () => {
  const voice = transport();
  const order: string[] = [];
  const join = voice.dependencies.join;
  voice.dependencies.join = ((options: Parameters<typeof join>[0]) => { order.push("join"); return join(options); }) as typeof join;
  voice.decode = async (file) => {
    order.push(`decode:${file}`);
    if (file === "second.wav") throw new Error("broken second chunk");
    return pcm(960);
  };
  await assert.rejects(voice.play(chunks("first.wav", "second.wav")), /broken second chunk/);
  assert.deepEqual(order.slice(0, 2), ["decode:first.wav", "join"]);
  assert.equal(voice.connectionDestroyed, 1);
});

test("encoder errors after playback starts reject instead of reporting success", async () => {
  const voice = transport();
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => voice.encoder.emit("error", new Error("broken audio")));
    });
  };
  await assert.rejects(voice.play(), /encode the announcement audio|broken audio/);
  assert.equal(voice.connectionDestroyed, 1);
});

test("playback that stops before the last chunk is not success", async () => {
  const voice = transport();
  const never = deferred<void>();
  async function* stalled() {
    yield "first.wav";
    await never.promise;
  }
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => voice.player.transition(AudioPlayerStatus.Idle));
    });
  };
  await assert.rejects(voice.play(stalled()), /stopped before every sentence/);
  assert.equal(voice.connectionDestroyed, 1);
});

test("connection disconnect during playback rejects and destroys the transport", async () => {
  const voice = transport();
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => voice.connection.transition(VoiceConnectionStatus.Disconnected));
    });
  };
  await assert.rejects(voice.play(), /connection ended|aborted/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
});

test("abort while waiting for the next chunk destroys its connection and streams", async () => {
  const voice = transport();
  const controller = new AbortController();
  const never = deferred<void>();
  async function* waiting() {
    yield "first.wav";
    setImmediate(() => controller.abort(new Error("session stopped")));
    await never.promise;
  }
  await assert.rejects(voice.play(waiting(), controller.signal), /aborted|session stopped/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.input!.destroyed, true);
  assert.equal(voice.encoder.destroyed, true);
});

test("already aborted calls never join a voice channel", async () => {
  const voice = transport();
  const controller = new AbortController();
  controller.abort(new Error("cancel before join"));
  await assert.rejects(voice.play(chunks("test.wav"), controller.signal), /cancel before join/);
  assert.equal(voice.joins, 0);
  assert.deepEqual(voice.decoded, []);
});

test("a synchronous play error still cleans transport and does not leak pending waits", async () => {
  const voice = transport();
  voice.onPlay = () => { throw new Error("play threw"); };
  await assert.rejects(voice.play(), /play threw/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.encoder.destroyed, true);
});

test("missing player subscription fails before audio starts", async () => {
  const voice = transport();
  voice.connection.subscribe = () => undefined;
  await assert.rejects(voice.play(), /could not subscribe/);
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready]);
  assert.equal(voice.connectionDestroyed, 1);
});

test("audio that never starts times out and cleans its transport", async () => {
  const voice = transport();
  voice.onPlay = () => undefined;
  const keepAlive = setTimeout(() => undefined, 500);
  try {
    await assert.rejects(voice.play(chunks("test.wav"), undefined, 20), /aborted/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
});

/** A Ready -> Connecting -> Ready blip while playback runs, like a voice WebSocket resume. */
test("a brief reconnect mid-playback keeps the announcement and plays it to the end", async () => {
  const voice = transport();
  voice.dependencies.reconnectGraceMs = 100;
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      voice.connection.transition(VoiceConnectionStatus.Signalling);
      setTimeout(() => voice.connection.transition(VoiceConnectionStatus.Connecting), 5);
      setTimeout(() => voice.connection.transition(VoiceConnectionStatus.Ready), 30);
      // Playback outlasts the grace, so a grace timer left running after Ready would fail it.
      setTimeout(() => voice.player.transition(AudioPlayerStatus.Idle), 180);
    });
  };
  await voice.play();
  assert.equal(voice.playerOptions?.behaviors?.noSubscriber, NoSubscriberBehavior.Pause, "a blip pauses the player instead of stopping it");
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
});

/** Minimal connection surface the real AudioPlayer drives, counting the Opus packets it dispatches. */
class PacketConnection extends FakeStateMachine {
  joinConfig = { channelId: "voice" };
  sent = 0;
  private prepared = false;
  constructor() { super(VoiceConnectionStatus.Signalling); }
  subscribe(player: unknown) { return (player as { subscribe: (connection: unknown) => unknown }).subscribe(this); }
  prepareAudioPacket() { if (this.state.status === VoiceConnectionStatus.Ready) this.prepared = true; }
  dispatchAudio() { if (this.state.status === VoiceConnectionStatus.Ready && this.prepared) { this.prepared = false; this.sent++; } return true; }
  setSpeaking() { return true; }
  destroy() { this.transition(VoiceConnectionStatus.Destroyed); }
}

const pendingTimers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;

function realPlayerPlayback(connection: PacketConnection) {
  const dependencies = {
    join: () => { setTimeout(() => connection.transition(VoiceConnectionStatus.Ready), 5); return connection; },
    createPlayer: createAudioPlayer,
    createResource: createAudioResource,
    enter: entersState,
    decode: async () => pcm(24_000, 3000),
    reconnectGraceMs: 2000,
  } as unknown as VoicePlaybackDependencies;
  const channel = { id: "voice", guild: { id: "guild", voiceAdapterCreator: () => undefined } } as unknown as VoiceChannel;
  return createVoicePlayback(dependencies)(channel, chunks("a.wav", "b.wav"), 30_000);
}

test("the real audio player plays every packet through a Ready -> Connecting -> Ready blip", async () => {
  const connection = new PacketConnection();
  setTimeout(() => connection.transition(VoiceConnectionStatus.Connecting), 150);
  setTimeout(() => connection.transition(VoiceConnectionStatus.Ready), 300);
  await realPlayerPlayback(connection);
  // Two 0.5 s chunks plus the 350 ms sentence pause is about 67 frames of 20 ms.
  const expected = Math.round((1000 + SENTENCE_PAUSE_MS) / 20);
  assert.ok(connection.sent >= expected - 5, `only ${connection.sent} of about ${expected} packets were sent`);
});

test("a reconnect that outlasts the grace fails with a clear error and cleans the transport", async () => {
  const voice = transport();
  voice.dependencies.reconnectGraceMs = 40;
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      voice.connection.transition(VoiceConnectionStatus.Signalling);
      setTimeout(() => voice.connection.transition(VoiceConnectionStatus.Connecting), 5);
    });
  };
  const started = Date.now();
  await assert.rejects(voice.play(chunks("test.wav"), undefined, 10_000), /did not recover in time/);
  assert.ok(Date.now() - started < 2000, "the grace, not the playback timeout, ends the wait");
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
  assert.equal(voice.input!.destroyed, true);
  assert.equal(voice.encoder.destroyed, true);
});

test("Ready again in another channel fails instead of continuing there", async () => {
  const voice = transport();
  voice.dependencies.reconnectGraceMs = 500;
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      voice.connection.transition(VoiceConnectionStatus.Signalling);
      setTimeout(() => {
        voice.connection.joinConfig.channelId = "somewhere-else";
        voice.connection.transition(VoiceConnectionStatus.Ready);
      }, 10);
    });
  };
  await assert.rejects(voice.play(chunks("test.wav"), undefined, 10_000), /moved to another channel/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
});

test("a paused player still ends at the playback timeout and an abort, and never leaves the grace timer running", async () => {
  const timedOut = transport();
  timedOut.dependencies.reconnectGraceMs = 60_000;
  timedOut.onPlay = () => {
    queueMicrotask(() => {
      timedOut.player.transition(AudioPlayerStatus.Playing);
      timedOut.connection.transition(VoiceConnectionStatus.Signalling);
    });
  };
  const started = Date.now();
  await assert.rejects(timedOut.play(chunks("test.wav"), undefined, 50), /aborted/);
  assert.ok(Date.now() - started < 2000);
  assert.equal(timedOut.connectionDestroyed, 1);
  assert.equal(timedOut.playerStopped, 1);

  const timersBefore = pendingTimers();
  const aborted = transport();
  aborted.dependencies.reconnectGraceMs = 60_000;
  const controller = new AbortController();
  aborted.onPlay = () => {
    queueMicrotask(() => {
      aborted.player.transition(AudioPlayerStatus.Playing);
      aborted.connection.transition(VoiceConnectionStatus.Connecting);
      setTimeout(() => controller.abort(new Error("session stopped")), 10);
    });
  };
  await assert.rejects(aborted.play(chunks("test.wav"), controller.signal, 10_000), /session stopped|aborted/);
  assert.equal(aborted.connectionDestroyed, 1);
  assert.equal(aborted.playerStopped, 1);
  assert.equal(pendingTimers(), timersBefore, "the 60 second grace timer is cleared on exit");
});

test("chunk PCM gets a leading pause, faded edges and whole 20 ms frames", () => {
  const prepared = prepareSpeechPcm(pcm(1000, 10_000), 100);
  const pause = 100 * 48 * 4;
  assert.equal(prepared.length % PCM_FRAME_BYTES, 0);
  assert.equal(prepared.length, Math.ceil((pause + 4000) / PCM_FRAME_BYTES) * PCM_FRAME_BYTES);
  assert.equal(prepared.readInt16LE(pause - 4), 0, "pause is silent");
  assert.equal(prepared.readInt16LE(pause), 0, "fade starts at zero");
  assert.equal(prepared.readInt16LE(pause + 2), 0, "both channels fade");
  assert.equal(prepared.readInt16LE(pause + 500 * 4), 10_000, "the middle is untouched");
  assert.ok(Math.abs(prepared.readInt16LE(pause + 999 * 4)) < 100, "fade ends near zero");
  assert.equal(prepared.readInt16LE(pause + 1000 * 4), 0, "frame padding is silent");
  assert.throws(() => prepareSpeechPcm(Buffer.alloc(0)), /invalid PCM/);
  assert.throws(() => prepareSpeechPcm(Buffer.alloc(6)), /invalid PCM/);
});

test("speech files decode through FFmpeg to 48 kHz stereo PCM", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-decode-"));
  try {
    const file = path.join(directory, "chunk.wav");
    const samples = 2400;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVE", 8);
    wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
    await writeFile(file, wav);
    const decoded = await decodeSpeechFile(file);
    // 0.1 s of 24 kHz mono becomes 0.1 s of 48 kHz stereo.
    assert.ok(Math.abs(decoded.length - samples * 2 * 4) <= 64 * 4, `decoded ${decoded.length} bytes`);
    assert.equal(decoded.length % 4, 0);
    await assert.rejects(decodeSpeechFile(path.join(directory, "missing.wav")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
