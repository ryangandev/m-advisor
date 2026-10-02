let stopping = false;

export function isStopping(): boolean { return stopping; }

/** Recheck after asynchronous boundaries before starting work or accessing stores. */
export function assertRunning(): void {
  if (stopping) throw new Error("当前 Bot 正在停止，请重新启动后再试。");
}

/** Mark shutdown before awaiting cleanup so no new lifecycle work can start. */
export function beginShutdown(): boolean {
  if (stopping) return false;
  stopping = true;
  return true;
}
