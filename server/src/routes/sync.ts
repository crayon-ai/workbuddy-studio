import type { FastifyPluginCallback } from "fastify";
import {
  applyChanges,
  loadSyncDoc,
  saveSyncDoc,
  validAccountId,
  validSuffix,
  dataKey,
  metaKey,
  LIST_KEY,
  globalKey,
  emptySyncDoc,
  type SyncAccountMeta,
  type SyncChange,
  type SyncDoc,
} from "../sync-store.js";

export interface SyncRoutesOpts {
  projectRoot: string;
}

/** 同步允许的全局键（防止把任意 localStorage 垃圾塞进同步档） */
const GLOBAL_KEYS = new Set(["wb_theme", "wb_prechecks", "wb_pc_task"]);
const PLATS = new Set(["xhs", "douyin", "bili", "gzh", "web"]);
/** 单条变更值的上限（头像 base64 也远小于此） */
const MAX_VALUE = 8 * 1024 * 1024;
/** 单次推送的变更条数上限 */
const MAX_CHANGES = 20000;
/** 请求体上限（sendBeacon / 大头像兜底） */
const BODY_LIMIT = 32 * 1024 * 1024;

/** 账号 meta 清洗（对齐前端 importData 的收口规则） */
function sanitizeMeta(m: unknown): SyncAccountMeta | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  if (!validAccountId(o.id)) return null;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 100) : "未命名账号";
  const plat = typeof o.plat === "string" && PLATS.has(o.plat) ? o.plat : "web";
  const emoji = typeof o.emoji === "string" && o.emoji ? o.emoji.slice(0, 16) : "🌟";
  const bg = typeof o.bg === "string" && o.bg ? o.bg.slice(0, 128) : "";
  const createdAt = Number(o.createdAt) || Date.now();
  return { id: o.id, name, plat, emoji, bg, createdAt };
}

interface RawChange {
  kind?: unknown;
  accountId?: unknown;
  suffix?: unknown;
  value?: unknown;
  account?: unknown;
  accounts?: unknown;
  currentId?: unknown;
  key?: unknown;
}

/** 把前端推来的原始 JSON 逐条校验为受信的 SyncChange（非法条目直接丢弃） */
function validateChanges(raw: unknown): SyncChange[] {
  if (!Array.isArray(raw)) return [];
  const out: SyncChange[] = [];
  for (const item of raw.slice(0, MAX_CHANGES)) {
    const c = item as RawChange;
    if (!c || typeof c !== "object") continue;
    if (c.kind === "suffix") {
      if (!validAccountId(c.accountId) || !validSuffix(c.suffix)) continue;
      if (typeof c.value === "string") {
        if (c.value.length > MAX_VALUE) continue;
        out.push({ kind: "suffix", accountId: c.accountId, suffix: c.suffix, value: c.value });
      } else if (c.value === null) {
        out.push({ kind: "suffix", accountId: c.accountId, suffix: c.suffix, value: null });
      }
      continue;
    }
    if (c.kind === "meta") {
      const m = sanitizeMeta(c.account);
      if (!m || m.id !== c.accountId) continue;
      out.push({ kind: "meta", accountId: m.id, account: m });
      continue;
    }
    if (c.kind === "list") {
      if (!Array.isArray(c.accounts)) continue;
      const accounts = c.accounts.map(sanitizeMeta).filter((m): m is SyncAccountMeta => !!m);
      if (!accounts.length) continue;
      const currentId = validAccountId(c.currentId) ? c.currentId : null;
      out.push({ kind: "list", accounts, currentId });
      continue;
    }
    if (c.kind === "global") {
      if (typeof c.key !== "string" || !GLOBAL_KEYS.has(c.key)) continue;
      if (typeof c.value !== "string" || c.value.length > MAX_VALUE) continue; // 允许空串（如 wb_theme='' 表示默认主题）
      out.push({ kind: "global", key: c.key, value: c.value });
    }
  }
  return out;
}

function validateTombs(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (validAccountId(k) && typeof v === "number" && v > 0) out[k] = v;
  }
  return out;
}

/** 给前端的完整文档视图（账号数据嵌回 export-v2 形态，前端水合逻辑可直接消费） */
function toClientDoc(doc: SyncDoc) {
  const accounts = doc.accounts.map((a) => {
    const data: Record<string, string> = {};
    const prefix = `${a.id}|`;
    for (const [k, v] of Object.entries(doc.data)) {
      if (k.startsWith(prefix)) data[k.slice(prefix.length)] = v;
    }
    return { ...a, data };
  });
  return {
    rev: doc.rev,
    updatedAt: doc.updatedAt,
    currentId: doc.currentId,
    global: doc.global,
    accounts,
    savedAt: doc.savedAt,
    tombs: doc.tombs,
  };
}

export const syncRoutes: FastifyPluginCallback<SyncRoutesOpts> = (app, opts, done) => {
  app.get("/api/sync", async () => {
    const doc = loadSyncDoc(opts.projectRoot);
    return { success: true, data: toClientDoc(doc), error: null };
  });

  app.post(
    "/api/sync",
    { bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const body = (req.body ?? {}) as { changes?: unknown; tombs?: unknown };
      const changes = validateChanges(body.changes);
      const tombs = validateTombs(body.tombs);
      if (!changes.length && !Object.keys(tombs).length) {
        return reply
          .code(400)
          .send({ success: false, data: null, error: "WB_SYNC_EMPTY", message: "没有合法的变更可同步" });
      }
      const doc = loadSyncDoc(opts.projectRoot);
      const preRev = doc.rev; // 推送前的服务端 rev（客户端据此判断推送间隙是否有他端改动）
      const { doc: merged, applied } = applyChanges(doc, changes, tombs, Date.now());
      if (applied) saveSyncDoc(opts.projectRoot, merged);
      return { success: true, data: { ...toClientDoc(merged), baseRev: preRev }, error: null };
    }
  );

  done();
};

// 供测试引用的内部函数与常量
export const _internal = { validateChanges, validateTombs, sanitizeMeta, emptySyncDoc, dataKey, metaKey, LIST_KEY, globalKey };
