import type { FastifyPluginCallback } from "fastify";
import { fileURLToPath } from "node:url";
import path from "node:path";
import QRCode from "qrcode";
import { getLanToken, listLanAddresses } from "../lan.js";

export interface LanRoutesOpts {
  /** token 落盘位置的项目根（默认按本文件位置推导；测试可注入临时目录）。 */
  projectRoot?: string;
  /** 端口（默认读 PORT 环境变量，再默认 7788，与 index.ts 口径一致）。 */
  port?: number;
}

function defaultProjectRoot(): string {
  // dist/routes/lan.js → server/dist/routes → server → 项目根（src 同构）
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "../../..");
}

function currentPort(explicit?: number): number {
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const p = Number(process.env.PORT ?? 7788);
  return Number.isFinite(p) && p > 0 ? p : 7788;
}

/**
 * GET /api/lan-info —— 手机访问信息（仅本机或已授权设备可读，见 lan-auth 钩子）。
 * 返回候选局域网地址、访问 token、每个地址的完整 URL 和二维码（data URL）。
 */
export const lanRoutes: FastifyPluginCallback<LanRoutesOpts> = (app, opts = {}, done) => {
  app.get("/api/lan-info", async () => {
    const root = opts.projectRoot ?? defaultProjectRoot();
    const port = currentPort(opts.port);
    const token = getLanToken(root);
    const addrs = listLanAddresses();
    const entries: Array<{ address: string; name: string; url: string; qr: string }> = [];
    for (const a of addrs.slice(0, 3)) {
      const url = `http://${a.address}:${port}/?t=${token}`;
      const qr = await QRCode.toDataURL(url, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 260,
        color: { dark: "#2A2018", light: "#FFFFFF" },
      });
      entries.push({ ...a, url, qr });
    }
    return {
      success: true,
      data: { port, token, addresses: entries, hasLan: entries.length > 0 },
      error: null,
    };
  });
  done();
};
