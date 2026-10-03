# Local speech

The default TTS provider is the installed Qwen CustomVoice model running offline through MLX-Audio.
The bot launches one Python worker on first use or during `prewarmTTS()` and keeps its model loaded until shutdown.
Announcements from all servers share a bounded queue and run one at a time.
`sweet` selects Serena and `old` selects Uncle_Fu.
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
| `TTS_PROVIDER` | `local` | Choose `local` or explicitly opt into `azure` |
| `LOCAL_TTS_MEDIA_ROOT` | `~/Documents/media` | Shared runtime and model workspace |
| `LOCAL_TTS_PYTHON` | `<media>/voice-engine/.venv/bin/python` | Interpreter with MLX-Audio already installed |
| `LOCAL_TTS_MODEL_RECORD` | `<media>/voice-engine/model.json` | Snapshot revision and expected file sizes |
| `LOCAL_TTS_WORKER` | `<bot>/scripts/tts_worker.py` | Persistent worker script |
| `LOCAL_TTS_TIMEOUT_MS` | `180000` | Total deadline from enqueue, including cold startup |
| `LOCAL_TTS_QUEUE_LIMIT` | `8` | Maximum active and queued requests combined |

The bot passes arguments directly to the interpreter without a shell.
The worker does not inherit Discord, Riot or Azure credentials.
Speech text is delivered over stdin and generated audio stays in a unique temporary directory.
Normal announcements are limited to 1000 characters and 2048 model tokens to bound inference.
Long passages should be split into shorter announcements.

## Lifecycle and playback

`generateTTS(text, style)` returns the absolute path to a unique mono, 24 kHz, 16-bit PCM WAV.
The playback caller removes that file after playback, including when playback fails.
`shutdownTTS()` stops the Python worker, rejects pending requests and removes remaining temporary files.
Shutdown is idempotent.
The bot must call it when stopping so model memory is released.
Once application shutdown begins, the public speech boundary rejects new requests and late completions.
Azure shutdown aborts pending fetch and response-body work and waits for its temporary-file cleanup.

`prewarmTTS()` starts and loads the selected provider before the first announcement.
For local speech, `checkTTS()` also loads the worker and returns the provider, model and installed revision.
For Azure, `checkTTS()` validates local configuration only; it does not prove credentials or connectivity are valid.

A full queue rejects new announcements with a clear error.
A generation failure leaves the worker available for the next request.
A crash, malformed protocol response or active request deadline stops the worker and rejects its current queue.
The next request starts a fresh worker.
The transport does not replay failed announcements automatically, allowing the match monitor to control retry and duplicate prevention.
There is no automatic change from local speech to a paid provider, or from Azure to local speech.
Worker diagnostics and Azure error response bodies are not printed to bot logs.

## Verification

```sh
node --import tsx --test tests/tts-local.test.ts tests/tts-provider.test.ts
```

The fake worker tests cover process reuse, serialized requests, both voices, queue limits, generation errors, crash recovery, deadline recovery, immediate startup retries, configuration repair, startup and shutdown, malformed responses, invalid audio, canonical paths, partial-file cleanup and credential isolation.
Azure tests cover SSML escaping, explicit provider selection, configuration errors, sanitized failures and in-flight shutdown.
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

## Troubleshooting

If the model or Python environment is missing, confirm the configured paths and follow the shared Media documentation.
Do not install speech packages into this repository's Node environment, move the shared virtual environment or trigger a model download during bot startup.
Use the Media installation workflow explicitly when rebuilding the speech runtime.

Cold Python imports and model loading can be much slower under memory pressure than warm generation.
Increase `LOCAL_TTS_TIMEOUT_MS` if the existing model is valid but startup exceeds its deadline, or close other memory-heavy applications.
After an active timeout, the next call loads a new worker; repeated retries do not improve cold loading time.
Use prewarming before a gaming session to resolve loading errors early.

To use the original Azure provider, explicitly set `TTS_PROVIDER=azure`, `AZURE_TTS_KEY`, and `AZURE_TTS_REGION`.
Azure requests have a 30-second deadline and produce temporary MP3 audio.
Changing voice providers should be followed by a bot restart.
