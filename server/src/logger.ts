import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 单文件超过 5MB 轮转为 .old，防止无限增长 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** 项目根（src/logger.ts → server/ → 项目根），与 app.ts 推导方式一致 */
function projectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** 默认日志文件：<项目根>/logs/server.log */
export function logFilePath(): string {
  return path.join(projectRoot(), "logs", "server.log");
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.old`); // rename 会覆盖已有 .old，始终只保留一代
  } catch {
    /* 轮转失败不影响日志写入 */
  }
}

/**
 * 把进程的 stdout/stderr 镜像追加到日志文件（tee 模式：终端照常输出）。
 * 在进程内部挂钩，保证任何启动方式（npm run dev / npm start / .app 双击）都落盘。
 * 写盘失败只丢日志，绝不影响主流程。
 */
export function teeToFile(logFile: string = logFilePath()): void {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    rotateIfNeeded(logFile);
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: Uint8Array | string, enc?: unknown, cb?: unknown) => {
        try {
          appendFileSync(logFile, typeof chunk === "string" ? chunk : Buffer.from(chunk));
        } catch {
          /* 磁盘满/权限问题等，忽略 */
        }
        return original(chunk as Uint8Array | string, enc as any, cb as any);
      }) as typeof stream.write;
    }
    appendFileSync(logFile, `\n===== ${new Date().toISOString()} 进程启动（pid ${process.pid}）=====\n`);
  } catch {
    /* 日志初始化失败（如目录不可写）不阻断服务启动 */
  }
}
