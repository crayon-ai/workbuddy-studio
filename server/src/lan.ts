import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import path from "node:path";

/**
 * 局域网（手机）访问支持：
 * - 首次用到时生成随机 token，持久化到 <项目根>/data/lan-token.txt，
 *   重启不变（电脑端二维码长期有效）；
 * - 电脑本机（loopback）访问 API 免 token，手机等局域网设备必须带
 *   x-wb-token 头（或 ?t= 查询参数）且值一致才放行。
 */

/** 常见虚拟网卡名前缀（docker / 虚拟机 / VPN 隧道等），展示手机访问地址时应排除。 */
const VIRTUAL_IF_PREFIXES = [
  "docker", "veth", "br-", "bridge", "virbr", "utun", "tun", "tap",
  "awdl", "llw", "anpi", "ap", "wg", "zt", "ham", "gpd",
];

export function isLoopback(ip: string | undefined | null): boolean {
  if (!ip) return true; // 取不到来源 IP（如测试 inject）时按本机处理
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "::ffff:localhost";
}

/** token 是否合法（timing-safe 比较，长度不同直接否）。 */
export function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** 进程内缓存（token 落盘后不变，免得每个请求都读一次磁盘）。 */
const tokenCache = new Map<string, string>();

/** 仅测试用：清空进程内 token 缓存。 */
export function resetLanTokenCache(): void {
  tokenCache.clear();
}

/** 读取（不存在则生成并落盘）局域网访问 token。 */
export function getLanToken(projectRoot: string): string {
  const cached = tokenCache.get(projectRoot);
  if (cached) return cached;
  const file = path.join(projectRoot, "data", "lan-token.txt");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) {
      tokenCache.set(projectRoot, saved);
      return saved;
    }
  }
  const token = randomBytes(16).toString("base64url"); // 22 位 URL 安全随机串
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, token + "\n", { mode: 0o600 });
  tokenCache.set(projectRoot, token);
  return token;
}

/** 从请求头或查询参数里取出手机端带来的 token。 */
export function tokenFromRequest(headers: Record<string, unknown>, query: Record<string, unknown>): string {
  const h = headers["x-wb-token"];
  const headerToken = Array.isArray(h) ? String(h[0]) : typeof h === "string" ? h : "";
  if (headerToken) return headerToken;
  const q = query?.t;
  return typeof q === "string" ? q : "";
}

export interface LanAddress {
  name: string;
  address: string;
}

/**
 * 列出可用于手机访问的局域网 IPv4 地址（过滤回环/虚拟网卡）。
 * 接受注入的接口表便于测试；以太网/WiFi（en*）排前面，其余真实网卡排后面。
 */
export function listLanAddresses(ifaces?: Record<string, NetworkInterfaceInfo[]>): LanAddress[] {
  const table = ifaces ?? networkInterfaces();
  const out: LanAddress[] = [];
  for (const [name, addrs] of Object.entries(table)) {
    if (!addrs) continue;
    const lower = name.toLowerCase();
    if (VIRTUAL_IF_PREFIXES.some((p) => lower.startsWith(p))) continue;
    for (const a of addrs) {
      if (a.internal || a.family !== "IPv4") continue;
      out.push({ name, address: a.address });
    }
  }
  out.sort((x, y) => {
    const px = /^en\d*$/.test(x.name) ? 0 : 1;
    const py = /^en\d*$/.test(y.name) ? 0 : 1;
    return px - py || x.name.localeCompare(y.name);
  });
  return out;
}
