import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyChanges,
  emptySyncDoc,
  loadSyncDoc,
  saveSyncDoc,
  dataKey,
  type SyncAccountMeta,
} from "./sync-store.js";

function acc(id: string, name = id): SyncAccountMeta {
  return { id, name, plat: "web", emoji: "🌟", bg: "", createdAt: 1 };
}

const T0 = 1_700_000_000_000;

describe("applyChanges", () => {
  it("suffix 变更：写入、覆盖、删除", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1")], currentId: "a1" }], {}, T0);
    const r1 = applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: '{"topics":[]}' }], {}, T0);
    expect(r1.applied).toBe(true);
    expect(doc.data[dataKey("a1", "main")]).toBe('{"topics":[]}');

    // 后到的推送覆盖先到的（last-push-wins）
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "v2" }], {}, T0 + 1);
    expect(doc.data[dataKey("a1", "main")]).toBe("v2");

    // value=null 表示删除
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: null }], {}, T0 + 2);
    expect(doc.data[dataKey("a1", "main")]).toBeUndefined();
    expect(doc.rev).toBe(4); // list + 3 次有效变更
  });

  it("同一账号不同栏目互不干扰（双端并发编辑的典型场景）", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1")], currentId: "a1" }], {}, T0);
    // 电脑端改了 main，手机端改了 mats：两次推送都应保留
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "pc" }], {}, T0 + 1);
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "mats", value: "phone" }], {}, T0 + 2);
    expect(doc.data[dataKey("a1", "main")]).toBe("pc");
    expect(doc.data[dataKey("a1", "mats")]).toBe("phone");
  });

  it("账号清单并集：并发新建的账号不丢", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1", "电脑已有")], currentId: "a1" }], {}, T0);
    // 手机端只见过 a1，但电脑端并发新建了 a2；手机端的 list 推送不能把 a2 挤掉
    applyChanges(doc, [{ kind: "meta", accountId: "a2", account: acc("a2", "电脑新建") }], {}, T0 + 1);
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1", "电脑已有")], currentId: "a1" }], {}, T0 + 2);
    const ids = doc.accounts.map((a) => a.id).sort();
    expect(ids).toEqual(["a1", "a2"]);
    expect(doc.currentId).toBe("a1");
  });

  it("meta 变更：改名生效且不覆盖其他账号", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1", "旧名"), acc("a2")], currentId: "a1" }], {}, T0);
    applyChanges(doc, [{ kind: "meta", accountId: "a1", account: { ...acc("a1", "新名") } }], {}, T0 + 1);
    expect(doc.accounts.find((a) => a.id === "a1")?.name).toBe("新名");
    expect(doc.accounts.find((a) => a.id === "a2")).toBeDefined();
  });

  it("墓碑：删除账号后，迟到的旧推送不能复活它", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1"), acc("a2")], currentId: "a1" }], {}, T0);
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "x" }], {}, T0 + 1);
    // a1 被删除
    applyChanges(doc, [], { a1: T0 + 2 }, T0 + 2);
    expect(doc.accounts.map((a) => a.id)).toEqual(["a2"]);
    expect(doc.data[dataKey("a1", "main")]).toBeUndefined();
    // 另一台设备迟到的 a1 数据推送 → 应被墓碑拦下
    const r = applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "late" }], {}, T0 + 3);
    expect(doc.data[dataKey("a1", "main")]).toBeUndefined();
    expect(doc.accounts.map((a) => a.id)).toEqual(["a2"]);
    expect(r.applied).toBe(false); // 全部被拦下，rev 不应递增
    expect(doc.currentId).toBeNull(); // currentId 指向已删账号时清空
  });

  it("重复推送相同值是彻底的 no-op（rev 不变，断线重发不扰动他端）", () => {
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1")], currentId: "a1" }], {}, T0);
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "v" }], {}, T0 + 1);
    const rev = doc.rev;
    const r = applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "v" }], {}, T0 + 2);
    expect(r.applied).toBe(false);
    expect(doc.rev).toBe(rev);
    expect(doc.data[dataKey("a1", "main")]).toBe("v");
  });

  it("global 变更与非法字段丢弃", () => {
    const doc = emptySyncDoc();
    applyChanges(
      doc,
      [
        { kind: "global", key: "wb_theme", value: "midnight" },
        { kind: "suffix", accountId: "bad id!", suffix: "main", value: "x" }, // 非法 id
        { kind: "suffix", accountId: "a1", suffix: "MAIN", value: "x" }, // 非法 suffix（大写）
      ],
      {},
      T0
    );
    expect(doc.global["wb_theme"]).toBe("midnight");
    expect(Object.keys(doc.data)).toEqual([]);
  });

  it("空变更 + 空墓碑：applied=false，rev 不变", () => {
    const doc = emptySyncDoc();
    const r = applyChanges(doc, [], {}, T0);
    expect(r.applied).toBe(false);
    expect(doc.rev).toBe(0);
  });
});

describe("loadSyncDoc / saveSyncDoc", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wb-sync-"));

  it("落盘可回读，备份滚动，损坏回退", () => {
    const root = path.join(dir, "p1");
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1", "一号")], currentId: "a1" }], {}, T0);
    saveSyncDoc(root, doc);

    const back = loadSyncDoc(root);
    expect(back.rev).toBe(doc.rev);
    expect(back.accounts[0].name).toBe("一号");
    expect(existsSync(path.join(root, "data", "sync.json.bak"))).toBe(false); // 首次写入无备份

    // 第二次保存 → 旧档进 .bak
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "v2" }], {}, T0 + 1);
    saveSyncDoc(root, doc);
    expect(existsSync(path.join(root, "data", "sync.json.bak"))).toBe(true);
    expect(loadSyncDoc(root).data[dataKey("a1", "main")]).toBe("v2");

    // 第三次保存 → .bak 滚入 .bak2
    applyChanges(doc, [{ kind: "suffix", accountId: "a1", suffix: "main", value: "v3" }], {}, T0 + 2);
    saveSyncDoc(root, doc);
    expect(existsSync(path.join(root, "data", "sync.json.bak2"))).toBe(true);

    // 主文件损坏 → 回退 .bak（内容是 v2 那版）
    writeFileSync(path.join(root, "data", "sync.json"), "{corrupted", "utf8");
    const recovered = loadSyncDoc(root);
    expect(recovered.data[dataKey("a1", "main")]).toBe("v2");

    // 没有任何文件 → 空文档
    const fresh = loadSyncDoc(path.join(dir, "p2"));
    expect(fresh.rev).toBe(0);
    expect(fresh.accounts).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("saveSyncDoc 后不存在 .tmp 残留", () => {
    const root = path.join(dir, "p3");
    const doc = emptySyncDoc();
    applyChanges(doc, [{ kind: "list", accounts: [acc("a1")], currentId: "a1" }], {}, T0);
    saveSyncDoc(root, doc);
    expect(existsSync(path.join(root, "data", "sync.json.tmp"))).toBe(false);
    const raw = JSON.parse(readFileSync(path.join(root, "data", "sync.json"), "utf8"));
    expect(raw.accounts[0].id).toBe("a1");
  });
});
