import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 数据同步存储（手机/电脑互通）：
 * - 唯一真源是本机 <项目根>/data/sync.json，前端 localStorage 降级为缓存；
 * - 合并粒度 = 账号×栏目（suffix）级 last-push-wins（时间戳由服务端盖章，
 *   免受设备时钟不准影响）；账号清单按 id 并集合并，删除走墓碑（tombstone）；
 * - 落盘原子（tmp + rename），并保留两份滚动备份（.bak / .bak2），
 *   主文件损坏时自动回退读取备份。
 */

export interface SyncAccountMeta {
  id: string;
  name: string;
  plat: string;
  emoji: string;
  bg: string;
  createdAt: number;
}

export interface SyncDoc {
  rev: number;
  updatedAt: number;
  /** 账号清单（顺序即展示顺序） */
  accounts: SyncAccountMeta[];
  currentId: string | null;
  /** 全局键（wb_theme 等），值一律为字符串 */
  global: Record<string, string>;
  /** "<accId>|<suffix>" -> 值（字符串） */
  data: Record<string, string>;
  /** 各键最后一次写入的服务端时间戳 */
  savedAt: Record<string, number>;
  /** 账号墓碑：accId -> 删除时间（已删账号永不复活） */
  tombs: Record<string, number>;
}

export type SyncChange =
  | { kind: "suffix"; accountId: string; suffix: string; value: string | null }
  | { kind: "meta"; accountId: string; account: SyncAccountMeta }
  | { kind: "list"; accounts: SyncAccountMeta[]; currentId: string | null }
  | { kind: "global"; key: string; value: string };

export function emptySyncDoc(): SyncDoc {
  return { rev: 0, updatedAt: 0, accounts: [], currentId: null, global: {}, data: {}, savedAt: {}, tombs: {} };
}

/** data 键与 savedAt 键的统一编码（id/suffix 字符集里不含 |） */
export function dataKey(accountId: string, suffix: string): string {
  return `${accountId}|${suffix}`;
}
export function metaKey(accountId: string): string {
  return `acc:${accountId}`;
}
export const LIST_KEY = "__list__";
export function globalKey(key: string): string {
  return `g:${key}`;
}

/** 校验账号 id / 栏目 suffix 字符集（与 account-dirs 的 accountSlug 同风格） */
export function validAccountId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
export function validSuffix(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9_]{1,32}$/.test(s);
}

export interface ApplyResult {
  doc: SyncDoc;
  /** 是否有任何变更被采纳（决定 rev 是否递增、是否落盘） */
  applied: boolean;
}

/**
 * 把一批变更合入文档（原地修改并返回同一引用）。
 * now 为本次请求的基准时间戳；同批内逐条 +1 保证严格递增，
 * 因此后到的推送对同一键永远覆盖先到的（last-push-wins，单一用户场景下
 * 「最后使用的设备」即用户最新意图）。
 */
export function applyChanges(doc: SyncDoc, changes: SyncChange[], tombs: Record<string, number>, now: number): ApplyResult {
  let stamp = now;
  const nextStamp = () => ++stamp;
  let applied = false;

  const touch = (key: string): number => {
    const t = nextStamp();
    doc.savedAt[key] = t;
    return t;
  };

  for (const accId of Object.keys(tombs || {})) {
    if (!validAccountId(accId)) continue;
    if (doc.tombs[accId] != null) continue; // 已有墓碑，保留更早的删除时间即可
    doc.tombs[accId] = nextStamp();
    // 删除账号：清单、数据、时间戳全部清掉
    doc.accounts = doc.accounts.filter((a) => a.id !== accId);
    for (const k of Object.keys(doc.data)) {
      if (k.startsWith(`${accId}|`) || k === accId) {
        delete doc.data[k];
        delete doc.savedAt[k];
      }
    }
    delete doc.savedAt[metaKey(accId)];
    if (doc.currentId === accId) doc.currentId = null;
    applied = true;
  }

  for (const ch of changes) {
    if (!ch || typeof ch !== "object") continue;
    if (ch.kind === "suffix") {
      if (!validAccountId(ch.accountId) || !validSuffix(ch.suffix)) continue;
      if (doc.tombs[ch.accountId] != null) continue;
      if (typeof ch.value !== "string" && ch.value !== null) continue;
      const key = dataKey(ch.accountId, ch.suffix);
      const cur = doc.data[key];
      if (ch.value === null) {
        if (cur === undefined) continue;
        delete doc.data[key];
      } else {
        if (cur === ch.value) continue; // 与现存值完全相同：无操作（重复推送/断线重发），不递增 rev
        doc.data[key] = ch.value;
      }
      touch(key);
      applied = true;
      continue;
    }
    if (ch.kind === "meta") {
      const m = ch.account;
      if (!validAccountId(ch.accountId) || !m || m.id !== ch.accountId) continue;
      if (doc.tombs[ch.accountId] != null) continue;
      const i = doc.accounts.findIndex((a) => a.id === ch.accountId);
      if (i >= 0) doc.accounts[i] = m;
      else doc.accounts.push(m);
      touch(metaKey(ch.accountId));
      applied = true;
      continue;
    }
    if (ch.kind === "list") {
      if (!Array.isArray(ch.accounts)) continue;
      const incoming = ch.accounts.filter((a) => a && validAccountId(a.id) && doc.tombs[a.id] == null);
      // 并集合并：以推送方的顺序为准，本地多出来的账号（其他设备并发新建）追加在尾部
      const byId = new Map(doc.accounts.map((a) => [a.id, a]));
      const merged: SyncAccountMeta[] = [];
      const seen = new Set<string>();
      for (const a of incoming) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        // 保留本地已有的 meta（改名等以 meta 变更为准，list 只管顺序/新增）
        merged.push(byId.get(a.id) ?? a);
      }
      for (const a of doc.accounts) {
        if (!seen.has(a.id)) merged.push(a);
      }
      doc.accounts = merged;
      if (ch.currentId == null || merged.some((a) => a.id === ch.currentId)) {
        doc.currentId = ch.currentId ?? null;
      }
      touch(LIST_KEY);
      applied = true;
      continue;
    }
    if (ch.kind === "global") {
      if (typeof ch.key !== "string" || typeof ch.value !== "string") continue;
      doc.global[ch.key] = ch.value;
      touch(globalKey(ch.key));
      applied = true;
    }
  }

  if (applied) {
    doc.rev += 1;
    doc.updatedAt = stamp;
  }
  return { doc, applied };
}

/* ---------- 落盘 ---------- */

function syncFilePath(projectRoot: string): string {
  return path.join(projectRoot, "data", "sync.json");
}

function parseDoc(raw: string): SyncDoc | null {
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return null;
    return {
      rev: Number(d.rev) || 0,
      updatedAt: Number(d.updatedAt) || 0,
      accounts: Array.isArray(d.accounts) ? d.accounts.filter((a: SyncAccountMeta) => a && validAccountId(a.id)) : [],
      currentId: typeof d.currentId === "string" ? d.currentId : null,
      global: d.global && typeof d.global === "object" ? d.global : {},
      data: d.data && typeof d.data === "object" ? d.data : {},
      savedAt: d.savedAt && typeof d.savedAt === "object" ? d.savedAt : {},
      tombs: d.tombs && typeof d.tombs === "object" ? d.tombs : {},
    };
  } catch {
    return null;
  }
}

/** 读取（主文件损坏依次回退 .bak / .bak2；都没有则返回空文档 rev=0） */
export function loadSyncDoc(projectRoot: string): SyncDoc {
  const file = syncFilePath(projectRoot);
  const candidates = [file, `${file}.bak`, `${file}.bak2`];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const doc = parseDoc(readFileSync(f, "utf8"));
    if (doc) return doc;
  }
  return emptySyncDoc();
}

/** 原子写入：滚动备份 .bak→.bak2、当前→.bak，然后 tmp+rename 落新档 */
export function saveSyncDoc(projectRoot: string, doc: SyncDoc): void {
  const file = syncFilePath(projectRoot);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const bak = `${file}.bak`;
  const bak2 = `${file}.bak2`;
  if (existsSync(bak)) copyFileSync(bak, bak2);
  if (existsSync(file)) copyFileSync(file, bak);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), "utf8");
  renameSync(tmp, file);
}
