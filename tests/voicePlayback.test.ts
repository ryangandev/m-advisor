import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ReadStream } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AudioPlayerStatus, VoiceConnectionStatus, entersState, type AudioResource } from "@discordjs/voice";
import type { VoiceChannel } from "discord.js";
import { createVoicePlayback, type VoicePlaybackDependencies } from "../src/utils/voicePlayback";

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

function transport() {
  const connection = new FakeStateMachine(VoiceConnectionStatus.Signalling) as FakeStateMachine & {
    subscribe: () => unknown; destroy: () => void;
  };
  let connectionDestroyed = 0;
  let playerStopped = 0;
  let joins = 0;
  let onRead: () => void = () => undefined;
  const source = new PassThrough();
  const decoded = new PassThrough();
  const player = new FakeStateMachine(AudioPlayerStatus.Idle) as FakeStateMachine & {
    play: (resource: AudioResource) => void; stop: () => void;
  };
  let onPlay = () => {
    queueMicrotask(() => {
      player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => player.transition(AudioPlayerStatus.Idle));
    });
  };
  connection.subscribe = () => ({});
  connection.destroy = () => { connectionDestroyed++; connection.transition(VoiceConnectionStatus.Destroyed); };
  player.play = () => onPlay();
  player.stop = () => { playerStopped++; player.transition(AudioPlayerStatus.Idle); };
  const statuses: string[] = [];
  const dependencies = {
    join: () => { joins++; queueMicrotask(() => connection.transition(VoiceConnectionStatus.Ready)); return connection; },
    createPlayer: () => player,
    createResource: () => ({ playStream: decoded }),
    enter: (target: Parameters<typeof entersState>[0], status: Parameters<typeof entersState>[1], signal: AbortSignal) => {
      statuses.push(status);
      return entersState(target, status, signal);
    },
    read: () => { onRead(); return source as unknown as ReadStream; },
  } as unknown as VoicePlaybackDependencies;
  const channel = { id: "voice", guild: { id: "guild", voiceAdapterCreator: () => undefined } } as unknown as VoiceChannel;
  return {
    connection, player, source, decoded, dependencies, statuses,
    get connectionDestroyed() { return connectionDestroyed; },
    get playerStopped() { return playerStopped; },
    get joins() { return joins; },
    set onPlay(value: () => void) { onPlay = value; },
    set onRead(value: () => void) { onRead = value; },
    play: (signal?: AbortSignal) => createVoicePlayback(dependencies)(channel, "test.wav", 1000, signal),
  };
}

test("voice playback observes Ready, Playing, then Idle and disposes its resources", async () => {
  const voice = transport();
  await voice.play();
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready, AudioPlayerStatus.Playing, AudioPlayerStatus.Idle]);
  assert.equal(voice.playerStopped, 1);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.source.destroyed, true);
  assert.equal(voice.decoded.destroyed, true);
});

test("initial Idle never counts as successful playback before audio starts", async () => {
  const voice = transport();
  voice.onPlay = () => setImmediate(() => voice.player.emit("error", new Error("decoder failed before Playing")));
  await assert.rejects(voice.play(), /playback failed|decoder failed/);
  assert.deepEqual(voice.statuses, [VoiceConnectionStatus.Ready, AudioPlayerStatus.Playing]);
  assert.equal(voice.connectionDestroyed, 1);
});

test("stream errors before connection readiness are handled and cleaned", async () => {
  const voice = transport();
  voice.onRead = () => queueMicrotask(() => voice.source.emit("error", new Error("missing file")));
  await assert.rejects(voice.play(), /read the announcement audio|missing file/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.source.destroyed, true);
});

test("decoder errors after playback starts reject instead of reporting success", async () => {
  const voice = transport();
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => voice.decoded.emit("error", new Error("broken audio")));
    });
  };
  await assert.rejects(voice.play(), /decode the announcement audio|broken audio/);
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

test("abort during playback destroys its connection and streams", async () => {
  const voice = transport();
  const controller = new AbortController();
  voice.onPlay = () => {
    queueMicrotask(() => {
      voice.player.transition(AudioPlayerStatus.Playing);
      setImmediate(() => controller.abort(new Error("session stopped")));
    });
  };
  await assert.rejects(voice.play(controller.signal), /aborted|session stopped/);
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.source.destroyed, true);
});

test("already aborted calls never join a voice channel", async () => {
  const voice = transport();
  const controller = new AbortController();
  controller.abort(new Error("cancel before join"));
  await assert.rejects(voice.play(controller.signal), /cancel before join/);
  assert.equal(voice.joins, 0);
});

test("a synchronous play error still cleans transport and does not leak pending waits", async () => {
  const voice = transport();
  voice.onPlay = () => { throw new Error("play threw"); };
  await assert.rejects(voice.play(), /play threw/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.decoded.destroyed, true);
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
  const channel = { id: "voice", guild: { id: "guild", voiceAdapterCreator: () => undefined } } as unknown as VoiceChannel;
  const keepAlive = setTimeout(() => undefined, 500);
  try {
    await assert.rejects(createVoicePlayback(voice.dependencies)(channel, "test.wav", 20), /aborted/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(voice.connectionDestroyed, 1);
  assert.equal(voice.playerStopped, 1);
});
