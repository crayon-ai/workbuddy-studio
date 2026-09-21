/**
 * 云端渲染读取兜底：小红书直连被强制登录墙/指纹校验拦截时，
 * 经「云端渲染服务」无凭证读取页面 og 元数据（标题/正文/互动/签名视频直链）。
 *
 * 两条通道（按优先级）：
 *  1. Firecrawl API 直连 —— server/.env 配了 FIRECRAWL_API_KEY 时启用；
 *  2. ChatCut MCP 桥 —— 本机装了 ChatCut（默认路径或 CHATCUT_MCP_PATH）时启用，
 *     走其 web_browser（Firecrawl 云端渲染）配额，中国出口；
 *  3. 智谱 web-reader —— API 底座是智谱（open.bigmodel.cn / api.z.ai）时启用，
 *     复用用户已配置的同一个 key（交付场景零额外配置）。对小红书渲染有波动
 *     且限流，内置登录墙检测 + 3 次退避重试。
 *
 * 红线遵守：全程无登录态、无本地浏览器自动化——渲染在云端完成且不携带
 * 任何用户凭证，与 xhs-no-login-guard 的规则一致。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ReaderNote {
  title: string;
  desc: string;
  author: string;
  timeMs: number;
  type: "normal" | "video" | string;
  like: string;
  fav: string;
  comment: string;
  videoUrl?: string;
  videoDurationSec?: number;
  imageUrls: string[];
}

/** 相对时间（「4天前」）或绝对日期 → 毫秒时间戳；解析不到返回 0。 */
function relTimeToMs(md: string): number {
  const m = md.match(/(\d+)\s*(秒|分钟|分|小时|天|周|月)\s*前/);
  if (m) {
    const unit: Record<string, number> = { 秒: 1e3, 分钟: 6e4, 分: 6e4, 小时: 36e5, 天: 864e5, 周: 6048e5, 月: 2592e6 };
    return Date.now() - Number(m[1]) * (unit[m[2]] ?? 0);
  }
  if (/昨天/.test(md)) return Date.now() - 864e5;
  if (/前天/.test(md)) return Date.now() - 2 * 864e5;
  const abs = md.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (abs) return new Date(`${abs[1]}-${abs[2]}-${abs[3]}T12:00:00+08:00`).getTime();
  return 0;
}

/**
 * Firecrawl 风格的抓取结果（markdown + metadata）→ ReaderNote。纯函数，可测。
 * 依据 og:* 元数据（小红书为搜索引擎/分享卡片输出了完整 og 协议），
 * 作者与发布时间从渲染后的 markdown 里补齐。
 */
export function parseReaderPayload(md: string, meta: Record<string, any>): ReaderNote | null {
  const get = (...keys: string[]): string => {
    for (const k of keys) {
      const v = meta[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const title = (get("og:title", "ogTitle", "title") || md.match(/^#\s+(.+)$/m)?.[1]?.trim() || "").replace(/\s*[-–]\s*小红书$/, "").trim();
  const desc = get("og:description", "ogDescription", "description");
  if (!title && !desc) return null;

  // 作者：头像/昵称链接指向 /user/profile/ 且其后紧跟「关注」按钮文案
  const author = md.match(/\[([^\]\n]{1,24})\]\(https:\/\/www\.xiaohongshu\.com\/user\/profile\/[^)]+\)\s*关注/)?.[1] ?? "";

  const videoUrl = get("og:video", "ogVideo") || undefined;
  const type = videoUrl || get("og:type", "ogType").includes("video") ? "video" : "normal";
  const vt = get("og:videotime", "ogVideotime", "ogVideoTime").match(/(\d+):(\d{1,2})/);
  const videoDurationSec = vt ? Number(vt[1]) * 60 + Number(vt[2]) : undefined;

  // og:image 可能是数组或字符串；过滤平台占位图（picasso-static/fe-static）与头像，补全协议
  const rawImgs = Array.isArray(meta["og:image"])
    ? meta["og:image"]
    : Array.isArray(meta["ogImage"])
      ? meta["ogImage"]
      : get("og:image", "ogImage")
        ? [get("og:image", "ogImage")]
        : [];
  const imageUrls = [...new Set(rawImgs.map((s: any) => String(s).trim()))]
    .filter((s) => /^https?:\/\//.test(s) || s.startsWith("//"))
    .filter((s) => /sns-(webpic|img)-/.test(s) && !/sns-avatar-/.test(s))
    .map((s) => (s.startsWith("//") ? "https:" + s : s.replace(/^http:/, "https:")));

  return {
    title,
    desc,
    author,
    timeMs: relTimeToMs(md),
    type,
    like: get("og:xhs:note_like", "ogXhsNoteLike") || "0",
    fav: get("og:xhs:note_collect", "ogXhsNoteCollect") || "0",
    comment: get("og:xhs:note_comment", "ogXhsNoteComment") || "0",
    videoUrl,
    videoDurationSec,
    imageUrls,
  };
}

/** 页面被验证码/登录墙接管的识别：Firecrawl 对被拦页面会返回 200 + 挑战页。 */
function assertNotChallenge(data: any): void {
  const finalUrl = String(data?.metadata?.url ?? "");
  const title = String(data?.metadata?.title ?? "");
  const md = String(data?.markdown ?? "");
  if (/website-login\/(captcha|error)|\/login\?/.test(finalUrl) || /Security Verification|Loading challenge/.test(title + md.slice(0, 400))) {
    throw new Error("云端渲染也被验证码/登录墙拦截（尝试更换出口或稍后重试）");
  }
}

/** 通道一：Firecrawl API 直连（需 FIRECRAWL_API_KEY，放 server/.env）。 */
async function scrapeViaFirecrawlApi(url: string): Promise<{ md: string; meta: Record<string, any> } | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const ask = async (body: Record<string, any>) => {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Firecrawl HTTP ${res.status}`);
    const j: any = await res.json();
    if (!j?.success || !j?.data) throw new Error(j?.error ?? "Firecrawl 返回无数据");
    return j.data;
  };
  // 中国出口优先（小红书对海外 IP 上验证码墙）；套餐不支持 geo 时降级普通出口再试
  let data: any;
  try {
    data = await ask({ url, formats: ["markdown"], onlyMainContent: false, timeout: 45000, location: { country: "cn" } });
  } catch (e: any) {
    if (!/HTTP 4\d\d/.test(String(e?.message))) throw e;
    data = await ask({ url, formats: ["markdown"], onlyMainContent: false, timeout: 45000 });
  }
  assertNotChallenge(data);
  return { md: String(data.markdown ?? ""), meta: data.metadata ?? {} };
}

/** 通道二：ChatCut MCP 桥（本机 ChatCut 自带的云端渲染配额，无需额外 key）。 */
async function scrapeViaChatcut(url: string): Promise<{ md: string; meta: Record<string, any> } | null> {
  const exe = process.env.CHATCUT_MCP_PATH || path.join(homedir(), "Library", "Application Support", "ChatCut", "chatcut-mcp");
  if (!existsSync(exe)) return null;

  return await new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ["pipe", "pipe", "ignore"] });
    const kill = () => { try { child.kill(); } catch { /* 已退出 */ } };
    const overall = setTimeout(() => { kill(); reject(new Error("ChatCut 读取超时")); }, 100000);

    let buf = "";
    const waiters = new Map<number, (msg: any) => void>();
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && waiters.has(msg.id)) {
            waiters.get(msg.id)!(msg);
            waiters.delete(msg.id);
          }
        } catch { /* 半行/心跳行，忽略 */ }
      }
    });
    child.on("error", (e) => { clearTimeout(overall); reject(e); });
    child.on("exit", () => {
      if (waiters.size) { clearTimeout(overall); reject(new Error("ChatCut MCP 提前退出")); }
    });

    const send = (obj: any) => child.stdin!.write(JSON.stringify(obj) + "\n");
    const call = (id: number, req: any, timeoutMs: number) =>
      new Promise<any>((res, rej) => {
        const t = setTimeout(() => rej(new Error("MCP 响应超时")), timeoutMs);
        waiters.set(id, (msg) => { clearTimeout(t); res(msg); });
        send(req);
      });

    (async () => {
      const init = await call(1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workbuddy-server", version: "0.1.0" } },
      }, 15000);
      if (init.error) throw new Error(String(init.error.message ?? "initialize 失败"));
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const r = await call(2, {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "web_browser", arguments: { url, formats: ["markdown"], onlyMainContent: false, country: "cn", timeout: 45000 } },
      }, 90000);
      clearTimeout(overall);
      kill();
      if (r.error) throw new Error(String(r.error.message ?? r.error));
      const text = (r.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new Error("ChatCut 返回内容无法解析为 JSON"); }
      const data = payload?.data ?? payload;
      if (!data?.markdown && !data?.metadata) throw new Error("ChatCut 返回无页面内容");
      assertNotChallenge(data);
      resolve({ md: String(data.markdown ?? ""), meta: data.metadata ?? {} });
    })().catch((e) => { clearTimeout(overall); kill(); reject(e); });
  });
}

/**
 * 通道三：智谱 web-reader（POST /api/paas/v4/reader）。
 * 仅当 LLM API 底座是智谱时启用，复用 .env 里已有的 ANTHROPIC_AUTH_TOKEN/API_KEY——
 * 交付场景下接收方本来就要配这把 key，无需任何额外注册。
 * 返回 null 表示当前配置不适用（非智谱底座/无 key），调用方继续下一通道。
 */
async function scrapeViaZhipuReader(url: string): Promise<{ md: string; meta: Record<string, any> } | null> {
  const base = (process.env.ANTHROPIC_BASE_URL || "").trim();
  const host = base.replace(/^https?:\/\//, "").split("/")[0];
  if (!/(^|\.)open\.bigmodel\.cn$|(^|\.)api\.z\.ai$/.test(host)) return null;
  const key = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const endpoint = `https://${host}/api/paas/v4/reader`;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastErr = "";
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(3000 * i); // 限流（429）退避
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ url, timeout: 45, return_format: "markdown", retain_images: true, no_cache: true }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        // 智谱 429 多为「余额不足/无资源包」（error 1113），重试无意义
        const body = await res.text().catch(() => "");
        const msg = body.match(/"message":"([^"]+)"/)?.[1] ?? "";
        lastErr = `429：${msg || "请求被拒"}`;
        if (/余额|资源包/.test(msg)) break;
        continue;
      }
      if (!res.ok) { lastErr = `HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 120); continue; }
      const j: any = await res.json();
      const r = j.reader_result ?? j;
      const meta = { ...(r.metadata ?? {}), title: r.metadata?.title ?? r.title ?? "" };
      // 登录墙空壳识别：真笔记页必有 og:title / og:description 元数据
      if (!meta["og:title"] && !meta["og:description"]) { lastErr = "被登录墙拦截（空壳页）"; continue; }
      return { md: String(r.content ?? ""), meta };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }
  throw new Error(`智谱读取连续失败（${lastErr}）`);
}

/**
 * 云端渲染读取小红书笔记。全部通道失败时抛错（消息含各通道原因），
 * 调用方按「又一策略失败」处理即可。
 */
export async function fetchXhsNoteViaReader(url: string): Promise<ReaderNote> {
  const errors: string[] = [];
  const channels: Array<{ name: string; run: () => Promise<{ md: string; meta: Record<string, any> } | null> }> = [
    { name: "Firecrawl API", run: () => scrapeViaFirecrawlApi(url) },
    { name: "ChatCut 云端渲染", run: () => scrapeViaChatcut(url) },
    { name: "智谱 web-reader", run: () => scrapeViaZhipuReader(url) },
  ];
  for (const ch of channels) {
    try {
      const got = await ch.run();
      if (!got) { errors.push(`${ch.name}：未配置/未安装，跳过`); continue; }
      const note = parseReaderPayload(got.md, got.meta);
      if (note) return note;
      errors.push(`${ch.name}：页面无笔记数据`);
    } catch (e: any) {
      errors.push(`${ch.name}：${e?.message ?? e}`);
    }
  }
  throw new Error(`云端读取全部失败（${errors.join("；")}）`);
}
