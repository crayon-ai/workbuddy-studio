/**
 * 任务级过程日志（console.log，经 logger.ts 的 tee 落到 logs/server.log）。
 * 格式与 deep-review / personalized / inspiration 现有日志一致：
 *   [HH:mm:ss] (+耗时s) [模块:taskId] 消息
 */

/** 带耗时前缀的任务日志。t0 传任务开始时间戳则追加 (+N.Ns)。 */
export function taskLog(module: string, taskId: string, msg: string, t0?: number): void {
  const hhmmss = new Date().toTimeString().slice(0, 8);
  const rel = t0 ? ` (+${((Date.now() - t0) / 1000).toFixed(1)}s)` : "";
  console.log(`[${hhmmss}]${rel} [${module}:${taskId}] ${msg}`);
}
