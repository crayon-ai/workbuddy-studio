/**
 * 小红书博主主页抓取（2026-09-23 按云端渲染方案重写）。
 *
 * 背景：平台已对主页笔记列表强制 xsec_token 门控——无凭证直连 fetch 主页会被 302 到
 * 登录页；即使拿到 SSR HTML，__INITIAL_STATE__.user.notes 对无 token 会话也是空的
 * （2026-08 的直连方案已失效，属平台侧收紧而非代码退化）。现走「带 xsec_token 的
 * 分享链接 → 云端渲染（reader-fetch 三通道）→ 解析渲染后的笔记卡片」，全程无登录态、
 * 无本地浏览器，与 xhs-no-login-guard 红线一致（xsec_token 是链接自带的分享凭证，
 * 不是会话凭证）。2026-09-22 已用真实主页端到端验证：10+ 粉小号可全量读出标题+点赞。
 *
 * 输入要求：小红书 App「主页 → 分享 → 复制链接」产出的链接（xhslink.com 短链或带
 * xsec_token 的完整链接）。裸链接（无 token）在入口直接拒绝并提示重新分享；
 * token 有时效，过期同样提示重新分享。
 *
 * 已知限制：主页卡片不含发布日期，ProfileNote.date 恒为 undefined（字段保留以兼容
 * 画像 prompt，日期列显示「未知」，时间加权退化为无日期模式）。
 */
import { fetchViaReader } from "./reader-fetch.js";

export interface ProfileNote {
  title: string;
  /** 发布日期 YYYY-MM-DD。云端渲染的主页卡片不含日期，恒为 undefined（保留字段兼容画像流程）。 */
  date?: string;
  likes?: string;
}

export interface BloggerProfile {
  nickname?: string;
  desc?: string;
  notes: ProfileNote[];
}

/** 接受小红书主页链接（/user/profile/<id>，可带 query）与 App 分享的 xhslink.com 短链（302 到带 token 的主页）。 */
export function isXhsProfileUrl(url: string): boolean {
  const u = url.trim();
  return (
    /^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\/\S+/i.test(u) ||
    /^https?:\/\/xhslink\.com\/\S+/i.test(u)
  );
}

const SHARE_HINT =
  "请在小红书 App 打开该主页，点右上角「分享 → 复制链接」，用新的分享链接重试";

/**
 * 渲染后的主页 markdown + og 元数据 → BloggerProfile。两种云端通道的卡片结构不同：
 *
 * Firecrawl（链接式）：
 *   [![](封面图)](…/user/profile/<id>/?xsec_token=…&xsec_source=pc_user)   ← 封面链接（跳过）
 *   [标题](…/user/profile/<id>/?xsec_token=…&xsec_source=pc_user)          ← 标题链接
 *   [![](头像)\\
 * 昵称](…xsec_source=pc_note) 36                                           ← 作者行，尾数为点赞
 * 页脚「通知/消息」链接同样指向 /user/profile/ 且带 pc_user，但 href 以 # 锚点结尾，
 * 用 [^)#\s] 排除；封面/作者链接的文本含内嵌图片标记，被 [^\]\n] 的标题捕获排除。
 *
 * 智谱 web-reader（纯文本式，2026-09-23 实抓）：无链接，按行排列——
 *   ![Image N](…sns-webpic…/封面.webp)   ← 笔记封面（页首头像为 sns-avatar，以此区分）
 *   标题（独占一行）
 *   ![Image M](…sns-avatar…/头像.webp)
 *   昵称（独占一行）
 *   36（点赞数独占一行）
 *
 * 先按链接式解析，拿不到笔记再退回纯文本式。
 */
export function parseProfileFromRender(md: string, meta: Record<string, any>): BloggerProfile {
  const pageTitle = String(meta.ogTitle ?? meta["og:title"] ?? meta.title ?? "");
  const nickname = pageTitle.replace(/\s*[-–—]\s*小红书\s*$/, "").trim() || undefined;

  // 简介：IP 属地行之后、统计行（以数字开头的「N岁 / N+关注 / 获赞数」）之前的非空文本
  let desc: string | undefined;
  const ipIdx = md.indexOf("IP属地：");
  if (ipIdx >= 0) {
    const lines: string[] = [];
    for (const raw of md.slice(ipIdx).split("\n").slice(1)) {
      const ln = raw.trim();
      if (!ln) continue;
      if (/^\d/.test(ln) || /^(关注|粉丝|获赞与收藏|已关注)$/.test(ln) || lines.length >= 5) break;
      lines.push(ln);
    }
    const joined = lines.join(" ").trim();
    if (joined && joined !== "还没有简介") desc = joined;
  }

  const linkNotes = parseCardsLinkStyle(md);
  const notes = linkNotes.length > 0 ? linkNotes : parseCardsLineStyle(md);
  return { nickname, desc, notes };
}

/** 点赞数形态：36 / 2034 / 1.2万（智谱纯文本式里独占一行，Firecrawl 式里跟在作者链接后）。 */
const LIKE_RE = /^([\d.,]+\s*[万w]?)$/;

/** Firecrawl 链接式卡片解析。 */
function parseCardsLinkStyle(md: string): ProfileNote[] {
  const notes: ProfileNote[] = [];
  const cardRe =
    /\[([^\]\n]{1,80})\]\(https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/[^)#\s]*xsec_source=pc_user\)/g;
  const cards = [...md.matchAll(cardRe)]
    .map((m) => ({ title: m[1].trim(), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((c) => c.title && !c.title.startsWith("!")); // 双保险：纯图片链接不做标题
  cards.forEach((c, i) => {
    // 点赞在「本标题 → 下一标题」窗口内找作者行（…xsec_source=pc_note) N），避免跨卡片误拿
    const next = cards[i + 1];
    const window = md.slice(c.end, Math.min(next ? next.start : c.end + 300, c.end + 300));
    const lm = window.match(/xsec_source=pc_note\)\s*([\d.,]+\s*[万w]?)/);
    notes.push({ title: c.title, likes: lm ? lm[1].replace(/\s+/g, "") : undefined });
  });
  return notes;
}

/** 智谱纯文本式卡片解析：封面图行 → 标题行 → 头像图行 → 作者行 →（可选）点赞行。 */
function parseCardsLineStyle(md: string): ProfileNote[] {
  const lines = md.split("\n");
  const notes: ProfileNote[] = [];
  const nextNonEmpty = (from: number): number => {
    for (let i = from; i < lines.length; i++) if (lines[i].trim()) return i;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/^!\[Image \d+\]\(https?:\/\/[^)\s]*sns-webpic-/.test(lines[i].trim())) continue; // 笔记封面
    const t = nextNonEmpty(i + 1);
    if (t < 0) break;
    const title = lines[t].trim();
    if (!title || title.startsWith("![") || title.length > 80) continue;
    // 找本卡片的头像图行，其后首行是作者，再后一行若是纯数字则为点赞
    let likes: string | undefined;
    let a = t + 1;
    let avatarIdx = -1;
    while (a < lines.length && a < t + 12) {
      if (/^!\[Image \d+\]\(https?:\/\/[^)\s]*sns-avatar-/.test(lines[a].trim())) {
        avatarIdx = a;
        break;
      }
      a++;
    }
    if (avatarIdx >= 0) {
      const author = nextNonEmpty(avatarIdx + 1);
      if (author >= 0) {
        const maybeLike = nextNonEmpty(author + 1);
        if (maybeLike >= 0 && LIKE_RE.test(lines[maybeLike].trim())) {
          likes = lines[maybeLike].trim().replace(/\s+/g, "");
          i = maybeLike; // 继续从点赞行之后找下一张封面
        }
      }
    }
    notes.push({ title, likes });
  }
  return notes;
}

/** 云端渲染抓取博主主页近期笔记。链接不带有效分享凭证时抛带指引的错误。 */
export async function fetchBloggerProfile(url: string): Promise<BloggerProfile> {
  const u = url.trim();
  if (!isXhsProfileUrl(u)) {
    throw new Error("暂只支持小红书主页链接");
  }
  // 裸主页链接（无 xsec_token）拿不到笔记列表，入口直接拒绝，省一次云端渲染
  if (/^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\//i.test(u) && !/[?&]xsec_token=/i.test(u)) {
    throw new Error(`主页链接缺少分享凭证（xsec_token）。${SHARE_HINT}`);
  }

  let got: { md: string; meta: Record<string, any> };
  try {
    got = await fetchViaReader(u, (md, meta) => parseProfileFromRender(md, meta).notes.length > 0);
  } catch (e: any) {
    throw new Error(`主页抓取失败：${e?.message ?? e}。${SHARE_HINT}`);
  }
  const profile = parseProfileFromRender(got.md, got.meta);
  if (profile.notes.length === 0) {
    throw new Error(`主页抓取失败：页面无笔记数据。${SHARE_HINT}`); // accept 已校验，防御性兜底
  }
  return profile;
}
