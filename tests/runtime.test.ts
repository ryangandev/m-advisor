import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getCiphers } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import ffmpeg from "ffmpeg-static";

test("installed FFmpeg decodes generated PCM into Discord Opus", () => {
  assert.ok(ffmpeg);
  const audio = execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-ar", "48000", "-ac", "2", "-c:a", "libopus", "-f", "ogg", "pipe:1"]);
  assert.ok(audio.length > 100);
  assert.equal(audio.subarray(0, 4).toString(), "OggS");
});

test("portable Opus encoder round-trips a Discord-sized PCM frame", () => {
  const OpusScript = require("opusscript");
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    const frame = Buffer.alloc(960 * 2 * 2);
    const packet = codec.encode(frame, 960);
    assert.ok(packet.length > 0);
    assert.equal(codec.decode(packet).length, frame.length);
  } finally { codec.delete(); }
});

test("runtime has native voice encryption and a loadable DAVE implementation", () => {
  assert.ok(getCiphers().includes("aes-256-gcm"));
  assert.ok(require("@snazzah/davey"));
  assert.equal(JSON.parse(fs.readFileSync("package.json", "utf8")).scripts.start, "node dist/index.js");
});
