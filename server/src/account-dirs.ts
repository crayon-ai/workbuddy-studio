import path from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

/** 5 个 skill 产物模块（与 data/ 下的目录名一致）。 */
export const DATA_MODULES = ["inspirations", "teardowns", "deep-reviews", "personalized", "prechecks"] as const;
export type DataModule = (typeof DATA_MODULES)[number];

/** 账号 id 只允许安全字符做目录名，其余一律回落 default（防路径穿越/非法目录名）。 */
export function accountSlug(accountId: unknown): string {
  const s = typeof accountId === "string" ? accountId.trim() : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : "default";
}

/** 3.0 账号内产物目录：data/accounts/<account>/<module>/<taskId>/ */
export function accountTaskDir(
  projectRoot: string,
  accountId: unknown,
  mod: DataModule,
  taskId: string
): string {
  return path.join(projectRoot, "data", "accounts", accountSlug(accountId), mod, taskId);
}

/** 2.0 旧目录：data/<module>/<taskId>/ */
export function legacyTaskDir(projectRoot: string, mod: DataModule, taskId: string): string {
  return path.join(projectRoot, "data", mod, taskId);
}

/**
 * 读侧解析（folder/reparse 用）：优先当前账号目录 → default 账号目录 → 2.0 旧目录。
 * 老记录（2.0 时代或 v1 备份导入）落在新账号名下时仍能打开。
 */
export function resolveTaskDir(
  projectRoot: string,
  accountId: unknown,
  mod: DataModule,
  taskId: string
): string {
  const slug = accountSlug(accountId);
  const candidates =
    slug === "default"
      ? [accountTaskDir(projectRoot, slug, mod, taskId), legacyTaskDir(projectRoot, mod, taskId)]
      : [
          accountTaskDir(projectRoot, slug, mod, taskId),
          accountTaskDir(projectRoot, "default", mod, taskId),
          legacyTaskDir(projectRoot, mod, taskId),
        ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0]; // 都不存在时返回首选，调用方按「目录不存在」报错
}

/** 启动惰性迁移：把 2.0 的 data/<module>/ 整体挪到 data/accounts/default/<module>/。幂等，返回迁移了的模块。 */
export function migrateLegacyDataDirs(projectRoot: string): string[] {
  const moved: string[] = [];
  for (const mod of DATA_MODULES) {
    const from = path.join(projectRoot, "data", mod);
    const to = path.join(projectRoot, "data", "accounts", "default", mod);
    if (!existsSync(from)) continue;
    if (existsSync(to)) continue; // 目标已存在（迁移过），保留 from 原地不动，避免覆盖
    try {
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
      moved.push(mod);
    } catch (e) {
      console.error(`[migrate] ${mod} 迁移失败：`, e);
    }
  }
  return moved;
}
