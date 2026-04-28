import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { spawn } from "node:child_process";
import type { CapturedCommandResult, WrappedClient } from "./types.js";

export async function runCapturedCommand(args: {
  spawnCommand: typeof spawn;
  tool: WrappedClient;
  commandArgs: string[];
  stdoutPath: string;
  stderrPath: string;
  mirrorStdout?: boolean;
  mirrorStderr?: boolean;
  timeoutMs?: number;
}): Promise<CapturedCommandResult> {
  const child = args.spawnCommand(args.tool, args.commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutFile = createWriteStream(args.stdoutPath);
  const stderrFile = createWriteStream(args.stderrPath);

  child.stdout?.pipe(stdoutFile);
  child.stderr?.pipe(stderrFile);

  if (args.mirrorStdout) {
    child.stdout?.pipe(process.stdout, { end: false });
  }
  if (args.mirrorStderr) {
    child.stderr?.pipe(process.stderr, { end: false });
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    let timeoutError: Error | undefined;
    const timeout =
      args.timeoutMs == null
        ? undefined
        : setTimeout(() => {
            timeoutError = new Error(
              `${args.tool} timed out after ${String(args.timeoutMs)}ms`,
            );
            child.kill("SIGTERM");
          }, args.timeoutMs);
    const clear = () => {
      if (timeout != null) {
        clearTimeout(timeout);
      }
    };
    child.once("error", (cause) => {
      clear();
      reject(cause);
    });
    child.once("close", (code: number | null) => {
      clear();
      if (timeoutError != null) {
        reject(timeoutError);
        return;
      }
      resolve(code ?? 1);
    });
  });

  await Promise.all([finished(stdoutFile), finished(stderrFile)]);
  return { exitCode };
}
