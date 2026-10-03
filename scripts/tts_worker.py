"""Persistent, offline-only Qwen CustomVoice worker using the shared MLX runtime."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
import wave

MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
SPEAKERS = {"Serena", "Uncle_Fu"}
MAX_TOKENS = 2048
INSTRUCTIONS = {
    "Serena": "像戏精附体的电竞女解说给朋友播报战绩，语气夸张，抑扬顿挫，带点阴阳怪气，表扬时激动亢奋，批评时毒舌嫌弃，吐字清楚。",
    "Uncle_Fu": "像说书先生一样的老军师给朋友播报战绩，抑扬顿挫，夸张幽默，表扬时拍案叫绝，批评时痛心疾首又阴阳怪气，吐字清楚。",
}

# Keep a private protocol descriptor. Python and native library progress output
# go to stderr so they cannot corrupt JSON responses on stdout.
PROTOCOL = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())


def send(value: dict) -> None:
    PROTOCOL.write(json.dumps(value, ensure_ascii=False) + "\n")
    PROTOCOL.flush()


def read_model(record_path: Path, media_root: Path) -> dict:
    record = json.loads(record_path.read_text(encoding="utf-8"))
    if record.get("repo_id") != MODEL or not isinstance(record.get("revision"), str):
        raise ValueError("Unexpected model record")
    snapshot = (media_root / record["snapshot"]).resolve()
    # Snapshot metadata is local configuration, but never allow it to select an
    # unrelated path or fetch an unrecorded remote repository.
    if not snapshot.is_relative_to(media_root):
        raise ValueError("Model snapshot is outside the media workspace")
    files = record.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("Model record has no files")
    for entry in files:
        candidate = snapshot / entry["path"]
        if ".." in Path(entry["path"]).parts or Path(entry["path"]).is_absolute():
            raise ValueError("Invalid model file path")
        if not candidate.is_file() or candidate.stat().st_size != entry["bytes"]:
            raise ValueError("A recorded model file is missing or changed")
    record["local_path"] = snapshot
    return record


def generate(request: dict, output_dir: Path, model, mx, np) -> dict:
    request_id = request.get("id")
    text = request.get("text")
    speaker = request.get("speaker")
    output_value = request.get("output")
    if (not isinstance(request_id, str) or not isinstance(text, str) or
            not text.strip() or len(text) > 1000 or speaker not in SPEAKERS or
            not isinstance(output_value, str)):
        raise ValueError("Invalid request")
    output = Path(output_value).resolve()
    if output.parent != output_dir or output.suffix != ".wav" or output.exists():
        raise ValueError("Invalid output path")

    started = time.monotonic()
    mx.random.seed(42)
    chunks = []
    sample_rate = model.sample_rate
    for result in model.generate_custom_voice(
            text=text.strip(), speaker=speaker, language="Chinese",
            instruct=INSTRUCTIONS[speaker], max_tokens=MAX_TOKENS):
        if result.token_count >= MAX_TOKENS:
            raise RuntimeError("Generation reached the token limit")
        chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
        sample_rate = result.sample_rate
    if not chunks or sample_rate != 24000:
        raise RuntimeError("No 24 kHz audio was generated")
    audio = np.concatenate(chunks)
    if audio.size == 0 or not np.isfinite(audio).all():
        raise RuntimeError("Invalid generated audio")
    original_peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms < 0.0001:
        raise RuntimeError("Generated audio is nearly silent")
    gain = min(1.0, 0.98 / original_peak)
    pcm = np.round(audio * gain * 32767).astype("<i2")
    temporary = output.with_suffix(".wav.tmp")
    try:
        with wave.open(str(temporary), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm.tobytes())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    result = {"id": request_id, "ok": True, "output": str(output),
              "speaker": speaker, "sample_rate": sample_rate,
              "duration_seconds": len(audio) / sample_rate,
              "generation_seconds": time.monotonic() - started,
              "peak_memory_gb": mx.get_peak_memory() / 1e9}
    del chunks, audio, pcm
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--model-record", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.media_root.resolve()
    output_dir = args.output_dir.resolve()
    os.environ["HF_HOME"] = str(root / "model-cache/huggingface")
    os.environ["HF_HUB_CACHE"] = str(root / "model-cache/huggingface/hub")
    os.environ["HF_XET_CACHE"] = str(root / "model-cache/huggingface/xet")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"

    try:
        record = read_model(args.model_record, root)
        if not output_dir.is_dir():
            raise ValueError("Output directory is unavailable")
        import mlx.core as mx
        import numpy as np
        from mlx_audio.tts.utils import load_model
        from transformers import AutoConfig, PreTrainedConfig

        class QwenTTSMetadataConfig(PreTrainedConfig):
            model_type = "qwen3_tts"

        # Same compatibility registration as the installed shared voice engine.
        AutoConfig.register("qwen3_tts", QwenTTSMetadataConfig, exist_ok=True)
        started = time.monotonic()
        model = load_model(record["local_path"])
        send({"event": "ready", "model": MODEL, "revision": record["revision"],
              "load_seconds": time.monotonic() - started})
    except Exception:
        send({"event": "fatal", "error": "configuration"})
        return 1

    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 16384:
                raise ValueError("Request is too large")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")
            request_id = request.get("id")
            send(generate(request, output_dir, model, mx, np))
        except ValueError:
            send({"id": request_id, "ok": False, "error": "invalid_request"})
        except Exception:
            send({"id": request_id, "ok": False, "error": "generation"})
        finally:
            # Release per-generation Metal caches even after a failed request.
            # The model weights remain loaded for the next announcement.
            mx.clear_cache()
    return 0


if __name__ == "__main__":
    sys.exit(main())
