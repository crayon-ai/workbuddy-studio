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
/** 把 markdown 按 ## 二级标题切分为 { 标题: 内容 }；同标题后者覆盖前者。 */
function splitSections(md: string): Record<string, string> {
  const sections: Record<string, string> = {};
  for (const sec of md.split(/^##\s+/m).slice(1)) {
    const line = sec.split("\n")[0].trim();
    if (line) {
      const idx = sec.indexOf("\n");
      sections[line] = idx < 0 ? "" : sec.slice(idx).trim();
    }
  }
  return sections;
}

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

  const sections = splitSections(md);

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
export function parseInspFields(block: string): Record<string, string> {
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

export interface Profile {
  /** 赛道定位（1-2 句） */
  track?: string;
  /** 内容支柱 */
  pillars: string[];
  /** 选题偏好（按近期权重排序） */
  topics: string[];
  /** 近期转向描述 */
  shift?: string;
  /** 供灵感抓取用的关键词（6-10 个） */
  keywords: string[];
}

/**
 * 从 skill 产物（profile.md，文件名含 profile）解析博主画像。
 * 支持两种产物形态（agent 偶发无视格式约束，实测两种都出现过）：
 *  1. 标准格式：`- key: value` 单行，多值 `|` 分隔（SKILL.md 规定）
 *  2. 自由报告：`key: value` / `### key:` 无前缀或标题形态，
 *     多值跟在 key 后的多行列表（- / * / 1. 开头，含 **加粗** 会清洗）
 * keywords 为空返回 null —— 调用方视为画像失败。
 */
export function parseProfile(artifacts: Record<string, string>): Profile | null {
  const entry = Object.entries(artifacts).find(([k]) => /profile/i.test(k));
  if (!entry) return null;
  const lines = entry[1].split("\n");
  const single = parseInspFields(entry[1]);
  const multi = collectProfileListFields(lines);

  const pick = (key: string): string | undefined => {
    const v = single[key] ?? findInlineValue(lines, key);
    const t = (v ?? "").trim();
    return t || undefined;
  };
  const split = (v: string | undefined) =>
    splitBar(v).map((s) => s.trim()).filter(Boolean);
  const list = (key: string): string[] => {
    const fromSingle = split(single[key]);
    return fromSingle.length ? fromSingle : multi[key] ?? [];
  };

  const keywords = list("keywords");
  if (!keywords.length) return null;
  return {
    track: pick("track") ?? pick("赛道"),
    pillars: list("pillars"),
    topics: list("topics"),
    shift: pick("shift"),
    keywords,
  };
}

/** key 的三种行形态：`- key: v`（parseInspFields 已处理）/ `key: v` / `### key: v`。 */
const KEY_RE = (key: string) => new RegExp(`^\\s*(?:#{1,6}\\s*|-\\s*)?${key}\\s*[:：]\\s*(.*)$`, "i");

/** 在自由报告里找 `key: value` 行的单行值（标准解析没拿到时兜底）。 */
function findInlineValue(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const m = line.match(KEY_RE(key));
    if (m && m[1].trim()) return m[1];
  }
  return undefined;
}

/** 列表行：`- item` / `* item` / `1. item`，清洗 **加粗**。 */
const LIST_ITEM_RE = /^\s*(?:[-*]|\d+[.、])\s+(.+)$/;

/** 收集自由报告形态的列表字段：`key:`（值为空）后跟的多行列表项。 */
function collectProfileListFields(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const keys = ["pillars", "topics", "keywords"];
  let current: string | null = null;
  for (const line of lines) {
    const keyMatch = keys.find((k) => {
      const m = line.match(KEY_RE(k));
      return m !== null;
    });
    if (keyMatch !== undefined) {
      // 进入该 key 的区块（值可能为空——列表在后续行）
      current = out[keyMatch] ? keyMatch : keyMatch;
      if (!out[current]) out[current] = [];
      continue;
    }
    if (current) {
      const item = line.match(LIST_ITEM_RE);
      if (item) {
        out[current].push(cleanListItem(item[1]));
        continue;
      }
      // 非列表行（含空行）结束当前区块
      if (line.trim() !== "") current = null;
    }
  }
  return out;
}

/** 清洗列表项：去 **加粗** 标记、去行尾权重注释（如 `(35%)`）。 */
function cleanListItem(raw: string): string {
  return raw.replace(/\*\*/g, "").replace(/\s*[（(]\d+%[)）]\s*$/, "").trim();
}

export interface DeepReview {
  sections: Record<string, string>;
  raw: string;
  reportFile?: string;
}

/**
 * 从 skill 产物识别深度复盘报告（文件名以 AI深度复盘 开头）。
 * 无报告返回 null；有报告则按 ## 二级标题切 sections。
 */
export function parseDeepReview(artifacts: Record<string, string>): DeepReview | null {
  const entry = Object.entries(artifacts).find(([k]) => k.startsWith("AI深度复盘"));
  if (!entry) return null;
  const [filename, md] = entry;
  return { sections: splitSections(md), raw: md, reportFile: filename };
}

/* ===== 爆款脚本创作（3.0）：结构拆解与脚本生成的产物解析 ===== */

/** 结构拆解里的一段：段名 / 手法 / 批注 / 原文摘录 */
export interface TearSegment {
  nm: string;
  tag?: string;
  why?: string;
  txt: string;
}

export interface ScriptTear {
  /** 识别出的赛道（一个词，如 美食 / 职场 / AI工具） */
  track: string;
  /** AI 匹配的公式标记（id 或名称，由路由结合公式清单解析成 id） */
  formula: string;
  /** 一句话匹配理由 */
  why?: string;
  /** 原样提取的原文脚本（口播逐字稿 / 图文正文） */
  script: string;
  raw: string;
  file?: string;
}

export interface ScriptGen {
  /** AI 给脚本起的标题 */
  title?: string;
  /** 完整正文（自然分段的整篇脚本） */
  text: string;
  raw: string;
  file?: string;
}

/**
 * 解析 structure.md（拆解产物，识别+匹配式）。约定格式：
 *   ## 赛道（一个词）/ ## 公式（清单里的 id 或名称）/ ## 匹配理由（一句话）/ ## 脚本（原文全文）
 * 兼容：字段带加粗、## 标题与内容之间有空行。脚本段必须非空才算有效产物。
 */
export function parseScriptTear(artifacts: Record<string, string>): ScriptTear | null {
  const entry = Object.entries(artifacts).find(([k]) => k === "structure.md" || k.startsWith("structure"));
  if (!entry) return null;
  const [filename, md] = entry;
  const strip = (v: string) => v.replace(/\*{1,3}/g, "").replace(/^["“「『](.*)["”』]\s*$/, "$1").trim();
  const track = strip(md.match(/##\s*赛道\s*\n+([^\n#]+)/)?.[1] ?? "");
  const formula = strip(md.match(/##\s*公式\s*\n+([^\n#]+)/)?.[1] ?? "");
  const why = strip(md.match(/##\s*匹配理由\s*\n+([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "");
  const script = strip(md.match(/##\s*脚本\s*\n?([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "");
  if (!script || !formula) return null;
  return { track: track || "未识别", formula, why: why || undefined, script, raw: md, file: filename };
}

/**
 * 解析 script.md（生成产物，整篇式）。约定格式：
 *   ## 标题（一行）/ ## 正文（完整脚本，自然分段，无编号无小标题无批注）
 * 兼容旧分段格式（## 结构 / ## 段N：段名/套用/正文）：没有「正文」节时把各段正文拼成整篇（段名/套用丢弃）。
 */
export function parseScriptGen(artifacts: Record<string, string>): ScriptGen | null {
  const entry = Object.entries(artifacts).find(([k]) => k === "script.md" || k.startsWith("script"));
  if (!entry) return null;
  const [filename, md] = entry;
  const strip = (v: string) => v.replace(/\*{1,3}/g, "").trim();
  const title = strip(md.match(/##\s*标题\s*\n+([^\n#]+)/)?.[1] ?? "");
  const text = strip(md.match(/##\s*正文\s*\n?([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "");
  if (text) return { title: title || undefined, text, raw: md, file: filename };
  // 旧分段格式：拼接各段正文
  const segRe = /##\s*段\s*(\d+)\s*\n([\s\S]*?)(?=\n##\s|$)/g;
  let m: RegExpExecArray | null;
  const parts: string[] = [];
  while ((m = segRe.exec(md))) {
    const t = strip(m[2].match(/-\s*正文[：:]?\s*\n?([\s\S]*?)(?=\n## |$)/)?.[1] ?? "");
    if (t) parts.push(t);
  }
  if (!parts.length) return null;
  return { title: undefined, text: parts.join("\n\n"), raw: md, file: filename };
}
