import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";

export const LOCAL_TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit";

export interface LocalTtsOptions {
  pythonPath: string;
  workerPath: string;
  mediaRoot: string;
  modelRecord: string;
  timeoutMs: number;
  queueLimit: number;
  workerEnv?: NodeJS.ProcessEnv;
}

export interface LocalTtsStatus {
  provider: "local";
  ready: true;
  model: string;
  revision: string;
}

interface Request {
  id: string;
  text: string;
  speaker: "Serena" | "Uncle_Fu";
  output: string;
  timer: NodeJS.Timeout;
  /** The caller cancelled while the worker was generating; its audio is deleted when it arrives. */
  abandoned: boolean;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

const WORKER_ERRORS: Readonly<Record<string, string>> = {
  configuration: "Local TTS model or Python dependencies are unavailable. Check docs/local-voice.md.",
  generation: "Local TTS could not generate speech. Try a shorter announcement.",
  invalid_request: "Local TTS received an invalid request.",
};

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

export function localTtsOptions(env = process.env): LocalTtsOptions {
  const mediaRoot = path.resolve(env.LOCAL_TTS_MEDIA_ROOT || path.join(os.homedir(), "Documents/media"));
  return {
    pythonPath: env.LOCAL_TTS_PYTHON || path.join(mediaRoot, "voice-engine/.venv/bin/python"),
    workerPath: path.resolve(env.LOCAL_TTS_WORKER || path.join(__dirname, "../../scripts/tts_worker.py")),
    mediaRoot,
    modelRecord: path.resolve(env.LOCAL_TTS_MODEL_RECORD || path.join(mediaRoot, "voice-engine/model.json")),
    timeoutMs: positiveInteger(env.LOCAL_TTS_TIMEOUT_MS, 180_000, "LOCAL_TTS_TIMEOUT_MS"),
    queueLimit: positiveInteger(env.LOCAL_TTS_QUEUE_LIMIT, 8, "LOCAL_TTS_QUEUE_LIMIT"),
  };
}

export const TTS_DIRECTORY_PREFIX = "m-advisor-tts-";
// New directories are `<prefix><pid>-<6 random chars>`; the older `<prefix><6 random chars>` has no owner recorded.
const TTS_DIRECTORY_NAME = /^m-advisor-tts-(?:(\d+)-)?[A-Za-z0-9]{6}$/;
const LEGACY_DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function processIsRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Removes speech directories a crashed or hung-up bot left in the temp directory.
 * Only real directories (never symlinks) owned by this user whose name matches the exact pattern are touched.
 * A directory whose recorded process is still running, and the one just created, are kept.
 * A legacy directory without a recorded process is removed only after a day, since its owner is unknown.
 */
export async function sweepStaleTtsDirectories(root: string, keep: string, now = Date.now()): Promise<void> {
  try {
    // The kept directory is a realpath while the temp root may be a symlink (macOS /var -> /private/var).
    const keepPath = await realpath(keep).catch(() => path.resolve(keep));
    const uid = process.getuid?.();
    for (const name of await readdir(root)) {
      const match = TTS_DIRECTORY_NAME.exec(name);
      if (!match) continue;
      const target = path.join(root, name);
      try {
        if ((await realpath(target).catch(() => path.resolve(target))) === keepPath) continue;
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (uid !== undefined && info.uid !== uid) continue;
        if (match[1] !== undefined) {
          if (Number(match[1]) === process.pid || processIsRunning(Number(match[1]))) continue;
        } else if (now - info.mtimeMs < LEGACY_DIRECTORY_MAX_AGE_MS) continue;
        await rm(target, { recursive: true, force: true });
      } catch { /* best effort: one unreadable entry never blocks speech */ }
    }
  } catch { /* the temp directory itself is unreadable: nothing to sweep */ }
}

/** One offline worker shared by all guilds, with bounded, serialized requests. */
export class LocalTtsService {
  private worker?: ChildProcessWithoutNullStreams;
  private readonly workers = new Set<ChildProcessWithoutNullStreams>();
  private lines?: Interface;
  private starting?: Promise<LocalTtsStatus>;
  private startupEpoch = 0;
  private ready?: LocalTtsStatus;
  private startupTimer?: NodeJS.Timeout;
  private startupReject?: (error: Error) => void;
  private queue: Request[] = [];
  private active?: Request;
  private outputDirectory?: Promise<string>;
  private closed = false;
  private stopping?: Promise<void>;

  constructor(private readonly options = localTtsOptions()) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        !Number.isSafeInteger(options.queueLimit) || options.queueLimit < 1) {
      throw new Error("Local TTS timeout and queue limit must be positive integers.");
    }
  }

  async prewarm(): Promise<LocalTtsStatus> {
    if (this.closed) throw new Error("Local TTS has been shut down.");
    if (this.ready) return this.ready;
    if (this.starting) return this.starting;

    // Assign the promise before any I/O so simultaneous requests start one worker.
    const epoch = ++this.startupEpoch;
    const starting = this.startWorker();
    this.starting = starting;
    try {
      return await starting;
    } catch (error) {
      // startWorker handles failures after spawning. Filesystem failures occur
      // before that point and are owned by this particular startup attempt.
      if (epoch === this.startupEpoch) {
        const failure = new Error(WORKER_ERRORS.configuration);
        this.failWorker(failure);
        throw failure;
      }
      throw error;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  /**
   * Generates one request. Aborting the signal rejects at once: a queued request is removed, and a request
   * the worker is already generating finishes in the background and its audio is deleted.
   */
  async generate(text: string, style = "old", signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const normalized = text.trim();
    if (!normalized) throw new Error("TTS text cannot be empty.");
    if (normalized.length > 1_000) throw new Error("TTS text must be at most 1000 characters.");
    if (this.closed) throw new Error("Local TTS has been shut down.");
    if (this.queue.length + (this.active ? 1 : 0) >= this.options.queueLimit) {
      throw new Error("Local TTS queue is full. Try again after the current announcements.");
    }

    const id = randomUUID();
    // Queue before awaiting startup or directory creation to enforce the limit.
    const result = new Promise<string>((resolve, reject) => {
      let settled = false;
      const onAbort = () => this.abandon(id, signal?.reason);
      const settle = () => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
      };
      const request: Request = {
        id,
        text: normalized,
        speaker: style === "sweet" ? "Serena" : "Uncle_Fu",
        output: "",
        timer: setTimeout(() => this.expire(id), this.options.timeoutMs),
        abandoned: false,
        resolve: (output) => { if (!settled) { settle(); resolve(output); } },
        reject: (error) => { if (!settled) { settle(); reject(error); } },
      };
      this.queue.push(request);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // Startup owns its failures. A stale subscriber must never stop a newer
    // worker started by an immediate retry from another request's catch.
    void this.prewarm().then(() => this.pump()).catch(() => {});
    return result;
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.stop();
    return this.stopping;
  }

  private abandon(id: string, reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error("Local TTS request was cancelled.");
    const index = this.queue.findIndex((request) => request.id === id);
    if (index >= 0) {
      const [request] = this.queue.splice(index, 1);
      clearTimeout(request.timer);
      request.reject(error);
      return;
    }
    // The worker cannot stop mid-generation without losing the loaded model, so the request keeps its
    // place and deadline, while the caller is released now.
    if (this.active?.id === id) {
      this.active.abandoned = true;
      this.active.reject(error);
    }
  }

  private async directory(): Promise<string> {
    this.outputDirectory ??= mkdtemp(path.join(os.tmpdir(), `${TTS_DIRECTORY_PREFIX}${process.pid}-`))
      .then(async (directory) => {
        const own = await realpath(directory);
        await sweepStaleTtsDirectories(os.tmpdir(), own);
        return own;
      });
    return this.outputDirectory;
  }

  private async startWorker(): Promise<LocalTtsStatus> {
    await Promise.all([access(this.options.pythonPath), access(this.options.workerPath), access(this.options.modelRecord)]);
    if (this.closed) throw new Error("Local TTS has been shut down.");
    const directory = await this.directory();
    if (this.closed) throw new Error("Local TTS has been shut down.");
    // The speech process receives no Discord or Riot credentials.
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    Object.assign(env, this.options.workerEnv, {
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      TOKENIZERS_PARALLELISM: "false",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONUNBUFFERED: "1",
    });

    const worker = spawn(this.options.pythonPath, [this.options.workerPath,
      "--media-root", this.options.mediaRoot,
      "--model-record", this.options.modelRecord,
      "--output-dir", directory,
    ], { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.worker = worker;
    this.workers.add(worker);
    worker.once("close", () => this.workers.delete(worker));
    // MLX diagnostics can be noisy and include user text. Drain, but never log them.
    worker.stderr.resume();

    return new Promise<LocalTtsStatus>((resolve, reject) => {
      this.startupReject = reject;
      this.startupTimer = setTimeout(() => {
        if (this.worker === worker) this.failWorker(new Error("Local TTS model loading timed out."));
      }, this.options.timeoutMs);
      this.lines = createInterface({ input: worker.stdout });
      this.lines.on("line", (line) => {
        if (this.worker !== worker) return;
        let response: Record<string, unknown>;
        try {
          if (line.length > 16_384) throw new Error("Response too large");
          response = JSON.parse(line) as Record<string, unknown>;
          if (!response || typeof response !== "object") throw new Error("Invalid response");
        } catch {
          this.failWorker(new Error("Local TTS worker returned an invalid response."));
          return;
        }
        if (response.event === "ready" && !this.ready) {
          if (response.model !== LOCAL_TTS_MODEL || typeof response.revision !== "string" || !response.revision) {
            this.failWorker(new Error("Local TTS worker loaded an unexpected model."));
            return;
          }
          clearTimeout(this.startupTimer);
          this.startupTimer = undefined;
          this.startupReject = undefined;
          this.ready = { provider: "local", ready: true, model: LOCAL_TTS_MODEL, revision: response.revision };
          resolve(this.ready);
        } else if (response.event === "fatal") {
          this.failWorker(new Error(WORKER_ERRORS.configuration));
        } else if (response.id === this.active?.id) {
          void this.complete(response, worker);
        } else {
          this.failWorker(new Error("Local TTS worker returned an unexpected response."));
        }
      });
      worker.once("error", () => {
        if (this.worker === worker) this.failWorker(new Error("Local TTS worker could not start."));
      });
      worker.once("exit", () => {
        if (this.worker === worker) this.failWorker(new Error("Local TTS worker exited. The next request will start it again."));
      });
      worker.stdin.on("error", () => {
        if (this.worker === worker) this.failWorker(new Error("Local TTS worker connection failed."));
      });
    });
  }

  private pump(): void {
    if (!this.worker || !this.ready || this.active || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    void this.directory().then((directory) => {
      if (this.active !== request || !this.worker) return;
      request.output = path.join(directory, `${request.id}.wav`);
      this.worker.stdin.write(`${JSON.stringify({ id: request.id, text: request.text,
        speaker: request.speaker, output: request.output })}\n`);
    }).catch(() => this.failWorker(new Error("Local TTS output directory is unavailable.")));
  }

  private async complete(response: Record<string, unknown>, worker: ChildProcessWithoutNullStreams): Promise<void> {
    const request = this.active;
    if (!request) return;
    if (response.ok !== true) {
      clearTimeout(request.timer);
      this.active = undefined;
      await this.removeOutput(request.output);
      request.reject(new Error(WORKER_ERRORS[String(response.error)] || WORKER_ERRORS.generation));
      this.pump();
      return;
    }
    try {
      if (response.output !== request.output) throw new Error("Unexpected output path");
      await this.validateWav(request.output);
      // A timeout or shutdown during validation still owns this request.
      if (this.active !== request || this.worker !== worker) return;
      clearTimeout(request.timer);
      this.active = undefined;
      if (request.abandoned) await this.removeOutput(request.output);
      else request.resolve(request.output);
    } catch {
      if (this.active !== request || this.worker !== worker) return;
      clearTimeout(request.timer);
      this.active = undefined;
      await this.removeOutput(request.output);
      request.reject(new Error("Local TTS returned invalid or empty PCM WAV audio."));
    }
    this.pump();
  }

  private async validateWav(output: string): Promise<void> {
    const file = await open(output, "r");
    try {
      const header = Buffer.alloc(44);
      const { bytesRead } = await file.read(header, 0, 44, 0);
      const info = await file.stat();
      if (bytesRead !== 44 || info.size <= 44 ||
          header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE" ||
          header.toString("ascii", 12, 16) !== "fmt " || header.readUInt32LE(16) !== 16 ||
          header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 ||
          header.readUInt32LE(24) !== 24_000 || header.readUInt16LE(34) !== 16 ||
          header.toString("ascii", 36, 40) !== "data" || header.readUInt32LE(40) === 0 ||
          header.readUInt32LE(40) + 44 !== info.size || header.readUInt32LE(4) + 8 !== info.size) {
        throw new Error("Invalid audio format");
      }
    } finally {
      await file.close();
    }
  }

  private expire(id: string): void {
    if (this.active?.id === id) {
      this.failWorker(new Error("Local TTS generation timed out. The next request will start a new worker."));
      return;
    }
    const index = this.queue.findIndex((request) => request.id === id);
    if (index >= 0) this.queue.splice(index, 1)[0].reject(new Error("Local TTS request timed out while waiting."));
    if (this.queue.length === 0 && !this.active && !this.ready && this.worker) {
      this.failWorker(new Error("Local TTS model loading timed out."));
    }
  }

  private failWorker(error: Error): void {
    ++this.startupEpoch;
    this.starting = undefined;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    const rejectStartup = this.startupReject;
    this.startupReject = undefined;
    rejectStartup?.(error);
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    this.lines?.close();
    this.lines = undefined;
    worker?.kill("SIGKILL");
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    for (const request of pending) {
      clearTimeout(request.timer);
      void this.removeOutput(request.output).then(() => request.reject(error));
    }
  }

  private async removeOutput(output: string): Promise<void> {
    if (!output) return;
    await Promise.all([output, `${output}.tmp`].map((file) => rm(file, { force: true }).catch(() => {})));
  }

  private async stop(): Promise<void> {
    const starting = this.starting;
    const exited = [...this.workers].map((worker) => new Promise<void>((resolve) => {
      worker.once("close", () => resolve());
      worker.kill("SIGKILL");
    }));
    this.failWorker(new Error("Local TTS has been shut down."));
    await Promise.all(exited);
    // startWorker can still be awaiting filesystem operations during shutdown.
    await starting?.catch(() => {});
    if (this.outputDirectory) await rm(await this.outputDirectory, { recursive: true, force: true });
  }
}
