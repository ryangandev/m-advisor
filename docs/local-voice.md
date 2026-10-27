# Local speech

The default TTS provider is the installed Qwen CustomVoice model running offline through MLX-Audio.
The bot launches one Python worker on first use or during `prewarmTTS()` and keeps its model loaded until shutdown.
Announcements from all servers share a bounded queue and run one at a time.
`sweet` selects Serena and `old` selects Uncle_Fu.
A server without a saved `/announcer` choice uses `old`.
Both voices speak Chinese.
Their style instructions ask for an exaggerated, theatrical delivery: excited praise and scornful, sarcastic criticism.

The existing speech installation is reused without changing the Media workspace or downloading model files.
The worker validates the model record and recorded file sizes, uses its local snapshot, and enables Hugging Face and Transformers offline mode before importing speech libraries.
The supported model is `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`.
Its installed revision is recorded in the shared `voice-engine/model.json`, rather than selected from the network.

## Configuration

All paths may be absolute.
The defaults below are derived from the current user's home directory, so another Mac can choose its own Media location.

| Setting | Default | Purpose |
| --- | --- | --- |
| `LOCAL_TTS_MEDIA_ROOT` | `~/Documents/media` | Shared runtime and model workspace |
| `LOCAL_TTS_PYTHON` | `<media>/voice-engine/.venv/bin/python` | Interpreter with MLX-Audio already installed |
| `LOCAL_TTS_MODEL_RECORD` | `<media>/voice-engine/model.json` | Snapshot revision and expected file sizes |
| `LOCAL_TTS_WORKER` | `<bot>/scripts/tts_worker.py` | Persistent worker script |
| `LOCAL_TTS_TIMEOUT_MS` | `180000` | Total deadline from enqueue, including cold startup |
| `LOCAL_TTS_QUEUE_LIMIT` | `8` | Maximum active and queued requests combined |

The bot passes arguments directly to the interpreter without a shell.
The worker does not inherit Discord or Riot credentials.
Speech text is delivered over stdin and generated audio stays in a unique temporary directory.
An announcement is limited to 1000 characters.
Each worker request is limited to 1000 characters and 2048 model tokens to bound inference.

## Sentence chunks

Announcements are split into sentence chunks so playback can start before the whole report is generated.
`src/utils/speechChunks.ts` ends a sentence at `。！？；…`, their ASCII forms `!?;` and line breaks, keeping any closing quotes or brackets.
ASCII full stops are never boundaries, so scores such as `9.9分` stay intact.
A sentence shorter than 10 characters joins the next one, and a short final sentence joins the chunk before it.
This keeps fragments such as `模拟战报。` out of their own request, and the first chunk long enough to cover the next chunk's generation.
A sentence longer than 80 characters is split after clause marks such as `，`, and only then at 80 characters.
Joining the chunks gives back the original text apart from whitespace at chunk edges.

Every chunk is an ordinary worker request with the announcement's speaker, the same style instruction and the same fixed seed, so the delivery stays consistent from sentence to sentence.
An announcement requests its chunks strictly in order and one at a time, without waiting for playback.
It therefore holds a single place in the worker queue, and announcements from different servers interleave chunk by chunk.
Each request has its own `LOCAL_TTS_TIMEOUT_MS` deadline from the moment it is queued.
See [Announcements](announcements.md#shared-voice-queue) for how chunks are played, cancelled and cleaned up.

## Lifecycle and playback

`generateTTS(text, style)` returns the absolute path to a unique mono, 24 kHz, 16-bit PCM WAV.
The playback caller removes that file after playback, including when playback fails.
`shutdownTTS()` stops the Python worker, rejects pending requests and removes remaining temporary files.
Shutdown is idempotent.
The bot must call it when stopping so model memory is released.
Once application shutdown begins, the public speech boundary rejects new requests and deletes late completions.

`prewarmTTS()` loads the model before the first announcement.
`checkTTS()` also loads the worker and returns the provider, model and installed revision.

A full queue rejects new announcements with a clear error.
A generation failure leaves the worker available for the next request.
A crash, malformed protocol response or active request deadline stops the worker and rejects its current queue.
The next request starts a fresh worker.
The transport does not replay failed announcements automatically, allowing the match monitor to control retry and duplicate prevention.
There is no cloud speech fallback.
Worker diagnostics are not printed to bot logs.

## Verification

```sh
node --import tsx --test tests/tts-local.test.ts tests/tts.test.ts
```

The fake worker tests cover process reuse, serialized requests, both voices, queue limits, generation errors, crash recovery, deadline recovery, immediate startup retries, configuration repair, startup and shutdown, malformed responses, invalid audio, canonical paths, partial-file cleanup and credential isolation.
`tests/lifecycle.test.ts` verifies that speech finishing after shutdown begins is deleted and never played.
These tests do not load model weights or call any external speech service.

Actual offline inference acceptance uses the installed Python runtime and model on Apple Silicon.
It should include two requests in one worker, full WAV decoding, warm generation timing and process shutdown.
Discord connection and human listening acceptance are separate checks.

The offline worker was exercised on 2026-10-02 with the installed revision `41d3337e8b7f2843a75841595fc14e4b9a7a4b96`.
Both requests used the same Chinese test announcement in one Python process.

| Measurement | Observed value |
| --- | --- |
| Initial Python startup and model load | 121.10 seconds |
| Model loading portion of initial startup | 47.58 seconds |
| Serena audio duration / generation | 6.80 / 43.53 seconds |
| Warm Uncle_Fu audio duration / generation | 9.12 / 25.89 seconds |
| Peak MLX memory across both requests | 7.29 GB |

Both WAVs fully decoded as non-silent mono, 24 kHz, 16-bit PCM audio with peaks below clipping.
The worker exited cleanly after stdin closed.
A later startup with a warm filesystem cache took 8.85 seconds, illustrating how much cold imports and machine load affect launch time.
These measurements validate local speech generation; they do not establish interactive conversation latency.

### Sentence-chunk latency

On 2026-10-27 the 284-character Uncle_Fu mock win report was timed on one warm worker, first as one request and then as sentence chunks.
Both runs used the real announcement queue, FFmpeg decoding, Opus encoder and `@discordjs/voice` audio player, with a local stand-in for the Discord voice connection.
Times are measured from the start of the announcement to the first non-silent Opus packet and to the end of playback.

| Measurement | One request | Sentence chunks |
| --- | --- | --- |
| Requests | 1 | 14 |
| First audible audio | 24.53 seconds | 1.79 seconds |
| Total generation | 23.95 seconds | 23.66 seconds |
| Audio played | 72.16 seconds | 82.52 seconds |
| Announcement total | 96.30 seconds | 84.39 seconds |
| Player silence while waiting for a chunk | 0 seconds | 0 seconds |

Every chunk was generated before the previous one finished playing; the slowest took 2.46 seconds.
Pauses between sentences measured 450 to 650 milliseconds in both versions.
The chunked report is longer because sentences generated on their own were spoken at a slightly slower pace.
The same day the model generated speech about three times faster than real time, faster than the 55.3 seconds for 74.8 seconds of audio measured on 2026-10-03, so generation speed varies with machine load.
Human listening of the chunked delivery is still pending.

## Troubleshooting

If the model or Python environment is missing, confirm the configured paths and follow the shared Media documentation.
Do not install speech packages into this repository's Node environment, move the shared virtual environment or trigger a model download during bot startup.
Use the Media installation workflow explicitly when rebuilding the speech runtime.

Cold Python imports and model loading can be much slower under memory pressure than warm generation.
Increase `LOCAL_TTS_TIMEOUT_MS` if the existing model is valid but startup exceeds its deadline, or close other memory-heavy applications.
After an active timeout, the next call loads a new worker; repeated retries do not improve cold loading time.
Use prewarming before a gaming session to resolve loading errors early.

