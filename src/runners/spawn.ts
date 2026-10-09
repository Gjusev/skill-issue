import { spawn } from "node:child_process";

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** External cancellation (CLI ctrl-c, test abort). */
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Upper bound for captured output per stream; protects the record size. */
  maxBufferChars?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  /** True when a capture cap cut the stream: integrity of the tail is unknown. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** Kill an entire process tree. On Windows child processes are not grouped,
 *  so taskkill /T is required; on POSIX we spawn detached and kill the group. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export function spawnCapturing(opts: SpawnOptions): Promise<SpawnResult> {
  const max = opts.maxBufferChars ?? 200_000;
  // An already-aborted signal must not spawn anything.
  if (opts.signal?.aborted) {
    return Promise.resolve({
      exitCode: null, timedOut: false, cancelled: true, stdout: "", stderr: "",
      error: null, stdoutTruncated: false, stderrTruncated: false,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      // New group on POSIX so we can kill the whole tree; harmless on Windows
      // (taskkill handles trees there).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false, // never: args are structured, paths may contain spaces
    });

    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const capOut = (s: string) => (stdout.length < max ? (stdout += s.slice(0, max - stdout.length)) : null);
    const capErr = (s: string) => (stderr.length < max ? (stderr += s.slice(0, max - stderr.length)) : null);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      capOut(chunk);
      outBuf += chunk;
      let i: number;
      while ((i = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, i).replace(/\r$/, "");
        outBuf = outBuf.slice(i + 1);
        opts.onStdoutLine?.(line);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      capErr(chunk);
      errBuf += chunk;
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).replace(/\r$/, "");
        errBuf = errBuf.slice(i + 1);
        opts.onStderrLine?.(line);
      }
    });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        // The child may have exited a hair earlier without 'close' yet firing;
        // only a live process can meaningfully time out.
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        killTree(child.pid ?? -1);
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      cancelled = true;
      killTree(child.pid ?? -1);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        timedOut,
        cancelled,
        stdout,
        stderr,
        error,
        stdoutTruncated: stdout.length >= max,
        stderrTruncated: stderr.length >= max,
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => {
      if (outBuf) opts.onStdoutLine?.(outBuf.replace(/\r$/, ""));
      if (errBuf) opts.onStderrLine?.(errBuf.replace(/\r$/, ""));
      finish(code, null);
    });
  });
}
