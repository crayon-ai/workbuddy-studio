export interface Title {
  t: string;
  mech?: string;
  emoji?: string;
  reason?: string;
}

/** 从 agent 返回文本里解析标题 JSON 数组（容错：支持 ```json 包裹或裸数组）。 */
export function parseTitles(text: string): Title[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is Title => !!x && typeof x.t === "string" && x.t.length > 0);
  } catch {
    return [];
  }
}

export interface TeardownMeta {
  title?: string;
  author?: string;
  date?: string;
  tags?: string[];
  likes?: string;
  favs?: string;
  comments?: string;
  shares?: string;
}

export interface Teardown {
  meta: TeardownMeta;
  sections: Record<string, string>;
  raw: string;
  reportFile?: string;
}

/** 合并元数据：b 填补 a 的空缺；tags 累加去重。 */
function mergeMeta(a: TeardownMeta, b: TeardownMeta): TeardownMeta {
  const out: TeardownMeta = { ...a };
  for (const k of Object.keys(b) as (keyof TeardownMeta)[]) {
    if (k === "tags") {
      const merged = [...(a.tags || []), ...(b.tags || [])];
      out.tags = [...new Set(merged)];
    } else {
      const bv = b[k];
      if (bv !== undefined && bv !== "" && (out[k] === undefined || out[k] === "")) {
        (out as any)[k] = bv;
      }
    }
  }
  return out;
}

/**
 * 从单个文件的文本提取元数据。兼容多种格式：
 *  - 笔记信息.md：`## 作者` `- 昵称：` `## 互动数据` `- 点赞：\d+`
 *  - 正文.md：`- 作者：` `- 发布时间：` `- 互动数据：赞 317 / 收藏 263 / ...`
 *  - AI拆解报告 frontmatter：`标题: x` `互动: 赞317 / 收藏263 / ...`
 */
function parseNoteMeta(text: string): TeardownMeta {
  const get = (re: RegExp): string | undefined => {
    const m = text.match(re);
    return m && m[1] ? m[1].trim() : undefined;
  };
  const title = get(/^#\s+(.+)$/m) || get(/^\s*标题[:：]\s*(.+)$/m);
  const author =
    get(/昵称[:：]\s*(.+)/) || get(/^\s*-?\s*作者[:：]\s*(.+)$/m);
  const date =
    get(/发布时间戳[:：]\s*\d+\s*[（(]([^)）]+)[)）]/) ||
    get(/发布时间[:：]\s*(.+)/) ||
    get(/^\s*拆解日期[:：]\s*(.+)$/m);
  const likes = get(/点赞[:：]\s*([\d.万kK]+)/) || get(/赞\s*(\d+)/);
  const favs = get(/收藏[:：]\s*([\d.万kK]+)/) || get(/收藏\s*(\d+)/);
  const comments = get(/评论数?[:：]\s*([\d.万kK]+)/) || get(/评论\s*(\d+)/);
  const shares = get(/分享[:：]\s*([\d.万kK]+)/) || get(/分享\s*(\d+)/);
  const tags = [...text.matchAll(/#([^#\[\s]+?)\[话题\]#/g)].map((m) => m[1]);
  return { title, author, date, likes, favs, comments, shares, tags };
}

/**
 * 从 skill 产物（.md 文件名 → 内容）提取拆解结果。
 * 元数据按优先级合并：笔记信息.md / 正文.md → AI拆解报告 frontmatter → 全扫兜底。
 */
export function parseTeardown(artifacts: Record<string, string>): Teardown {
  const priority = ["笔记信息.md", "正文.md"];
  let meta: TeardownMeta = {};

  // 1. 优先从笔记信息.md / 正文.md 提取
  for (const name of priority) {
    if (artifacts[name]) meta = mergeMeta(meta, parseNoteMeta(artifacts[name]));
  }

  // 2. AI拆解报告 frontmatter 兜底
  const entry = Object.entries(artifacts).find(([k]) => k.startsWith("AI爆款拆解"));
  if (entry) meta = mergeMeta(meta, parseNoteMeta(entry[1]));

  // 3. 仍缺关键字段 → 扫所有 .md
  if (!meta.title || !meta.likes) {
    for (const [name, content] of Object.entries(artifacts)) {
      if (priority.includes(name) || name.startsWith("AI爆款拆解")) continue;
      if (/互动|点赞|收藏|作者|昵称|发布时间/.test(content)) {
        meta = mergeMeta(meta, parseNoteMeta(content));
        if (meta.title && meta.likes) break;
      }
    }
  }

  if (!entry) return { meta, sections: {}, raw: "" };
  const [filename, md] = entry;

  const sections: Record<string, string> = {};
  for (const sec of md.split(/^##\s+/m).slice(1)) {
    const line = sec.split("\n")[0].trim();
    if (line) sections[line] = sec.slice(sec.indexOf("\n")).trim();
  }

  return { meta, sections, raw: md, reportFile: filename };
}

export interface Insp {
  pf: string;
  pfn: string;
  author: string;
  pub: string;
  t: string;
  s: string;
  url?: string;
  why: string[];
  m: [string, number, string][];
  cands: { g: string; t: string }[];
}

/**
 * 从 skill 产物（inspirations.md，文件名含 inspiration）解析灵感列表。
 * 每条以 `## N` 分隔，字段以 `- key: value` 形式；why/m/cands 多值用 `|` 分隔。
 * 容错：字段缺失用默认值；t 为空跳过整条；m 数字非法跳过该指标。
 */
export function parseInspiration(artifacts: Record<string, string>): Insp[] {
  const entry = Object.entries(artifacts).find(([k]) => /inspiration/i.test(k));
  if (!entry) return [];
  const out: Insp[] = [];
  for (const block of entry[1].split(/^##\s+/m).slice(1)) {
    const insp = parseInspBlock(block);
    if (insp) out.push(insp);
  }
  return out;
}

function parseInspBlock(block: string): Insp | null {
  const f = parseInspFields(block);
  const t = (f.t || "").trim();
  if (!t) return null;
  return {
    pf: (f.pf || "web").trim(),
    pfn: (f.pfn || "").trim(),
    author: (f.author || "").trim(),
    pub: (f.pub || "").trim(),
    t,
    s: (f.s || "").trim(),
    url: (f.url || "").trim() || undefined,
    why: splitBar(f.why).map((s) => s.trim()).filter(Boolean),
    m: parseInspMetrics(f.m),
    cands: parseInspCands(f.cands),
  };
}

/** 把 block 里的 `- key: value` 行解析为 { key: value }。 */
function parseInspFields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*-\s*([A-Za-z_]+)\s*[:：]\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function splitBar(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(/\s*\|\s*/);
}

/** 解析 m 字段：`热度,82,coral | 新颖,75,lav` → [['热度',82,'coral'],...] */
function parseInspMetrics(v: string | undefined): [string, number, string][] {
  const out: [string, number, string][] = [];
  for (const part of splitBar(v)) {
    const seg = part.split(/[,，]/).map((s) => s.trim());
    if (seg.length < 2) continue;
    const name = seg[0];
    const num = Number(seg[1]);
    if (!name || Number.isNaN(num)) continue;
    out.push([name, num, seg[2] || "lav"]);
  }
  return out;
}

/** 解析 cands 字段：`op,选题1 | method,选题2` → [{g:'op',t:'选题1'},...] */
function parseInspCands(v: string | undefined): { g: string; t: string }[] {
  const out: { g: string; t: string }[] = [];
  for (const part of splitBar(v)) {
    const idx = part.search(/[,，]/);
    if (idx < 0) continue;
    const g = part.slice(0, idx).trim();
    const t = part.slice(idx + 1).trim().replace(/^[,，]/, "");
    if (g && t) out.push({ g, t });
  }
  return out;
}
