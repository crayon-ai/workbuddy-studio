/**
 * 小红书博主主页抓取：直接 fetch 主页 HTML，从 __INITIAL_STATE__ 提取
 * 首屏近期笔记（标题/日期/点赞）与博主信息。不走 skill、不调 LLM。
 * 结构经 2026-08-23 spike 实测验证。
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ProfileNote {
  title: string;
  /** 发布日期 YYYY-MM-DD */
  date?: string;
  likes?: string;
}

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD；无效时间返回 undefined（手动 UTC+8，避免依赖 locale）。 */
export function toBeijingDate(time: unknown): string | undefined {
  const ms = new Date(time as any).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export interface BloggerProfile {
  nickname?: string;
  desc?: string;
  notes: ProfileNote[];
}

/** 仅接受小红书主页链接（/user/profile/<id>）。 */
export function isXhsProfileUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?xiaohongshu\.com\/user\/profile\/.+/.test(url.trim());
}

export async function fetchBloggerProfile(url: string): Promise<BloggerProfile> {
  if (!isXhsProfileUrl(url)) {
    throw new Error("暂只支持小红书主页链接");
  }
  let html: string;
  try {
    html = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://www.xiaohongshu.com/",
      },
    }).then((r) => r.text());
  } catch (e: any) {
    throw new Error("主页请求失败：" + (e?.message ?? e));
  }

  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) throw new Error("页面无 __INITIAL_STATE__（链接失效或被反爬）");

  // SSR 数据可能是严格 JSON，也可能是 JS 对象字面量（键无引号、值为 undefined）。
  // 先替换 undefined 字面量，优先 JSON.parse；失败再用受限 Function 求值兜底
  const sanitized = m[1].replace(/:\s*undefined/g, ":null").replace(/,\s*undefined/g, ",null");
  let state: any;
  try {
    try {
      state = JSON.parse(sanitized);
    } catch {
      state = new Function(`"use strict"; return (${sanitized});`)();
    }
  } catch (e: any) {
    throw new Error("解析页面数据失败: " + (e?.message ?? e));
  }

  // user.notes 是嵌套数组 [[note, ...首屏], [], ...]（react-query 风格），flatten 取非空
  const rawNotes: any[] = [];
  for (const sub of state?.user?.notes ?? []) {
    if (Array.isArray(sub)) rawNotes.push(...sub);
  }

  const notes: ProfileNote[] = rawNotes
    .map((n) => n?.noteCard ?? n)
    .filter((nc) => typeof nc?.displayTitle === "string" && nc.displayTitle.trim())
    .map((nc) => ({
      title: nc.displayTitle.trim(),
      date: toBeijingDate(nc.time),
      likes: nc.interactInfo?.likedCount != null ? String(nc.interactInfo.likedCount) : undefined,
    }));

  if (notes.length < 3) {
    throw new Error(
      "主页抓取失败：未拿到足够笔记（可能需要登录、链接失效或被反爬）。请检查链接是否为主页，稍后重试"
    );
  }

  const basic = state?.user?.userPageData?.basicInfo ?? {};
  return {
    nickname: typeof basic.nickname === "string" ? basic.nickname : undefined,
    desc: typeof basic.desc === "string" ? basic.desc : undefined,
    notes,
  };
}
