import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getLanToken, isLoopback, tokenEquals, listLanAddresses, resetLanTokenCache } from "./lan.js";
import { buildApp } from "./app.js";

let root: string;

beforeEach(() => {
  resetLanTokenCache();
  root = mkdtempSync(path.join(tmpdir(), "lan-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isLoopback", () => {
  it("本机/回环地址返回 true，取不到 IP 也按本机", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback(undefined)).toBe(true);
    expect(isLoopback("192.168.1.5")).toBe(false);
  });
});

describe("tokenEquals", () => {
  it("一致/不一致/长度不同", () => {
    const t = getLanToken(root);
    expect(tokenEquals(t, t)).toBe(true);
    expect(tokenEquals(t, t.slice(0, -1) + "x")).toBe(false);
    expect(tokenEquals(t, "")).toBe(false);
    expect(tokenEquals("", "")).toBe(false);
  });
});

describe("getLanToken", () => {
  it("生成后持久化，重复读取不变", () => {
    const t1 = getLanToken(root);
    expect(t1.length).toBeGreaterThanOrEqual(20);
    expect(existsSync(path.join(root, "data", "lan-token.txt"))).toBe(true);
    const t2 = getLanToken(root);
    expect(t2).toBe(t1);
    expect(readFileSync(path.join(root, "data", "lan-token.txt"), "utf8").trim()).toBe(t1);
  });

  it("已有文件时不覆盖（token 长期有效）", () => {
    getLanToken(root);
    const file = path.join(root, "data", "lan-token.txt");
    readFileSync(file, "utf8");
    // 写入一个已知值，再读应等于它（清缓存模拟重启进程）
    writeFileSync(file, "my-fixed-token\n");
    resetLanTokenCache();
    expect(getLanToken(root)).toBe("my-fixed-token");
  });
});

describe("listLanAddresses", () => {
  it("过滤回环/IPv6/虚拟网卡，en* 优先", () => {
    const fake: Parameters<typeof listLanAddresses>[0] = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
      en0: [{ address: "192.168.1.8", family: "IPv4", internal: false } as any],
      en1: [
        { address: "10.0.0.5", family: "IPv4", internal: false } as any,
        { address: "fe80::1", family: "IPv6", internal: false } as any,
      ],
      bridge100: [{ address: "192.168.64.1", family: "IPv4", internal: false } as any],
      utun3: [{ address: "198.18.0.1", family: "IPv4", internal: false } as any],
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false } as any],
    };
    const out = listLanAddresses(fake);
    expect(out.map((x) => x.address)).toEqual(["192.168.1.8", "10.0.0.5"]);
  });
});

describe("lan-auth 钩子（经 buildApp + inject）", () => {
  it("本机（loopback）免 token 访问 API", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/task/x" });
    // 200 即鉴权通过（业务上任务不存在是 success:false，不影响）
    expect(res.statusCode).toBe(200);
  });

  it("局域网来源无 token → 401 WB_LAN_TOKEN_REQUIRED", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({
      method: "GET",
      url: "/api/task/x",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("WB_LAN_TOKEN_REQUIRED");
  });

  it("错误 token → 401；正确 ?t= → 放行并下发 cookie", async () => {
    const app = await buildApp({ projectRoot: root });
    const token = getLanToken(root);

    const bad = await app.inject({
      method: "GET",
      url: `/api/task/x?t=wrong-token`,
      remoteAddress: "192.168.1.50",
    });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: "GET",
      url: `/api/task/x?t=${encodeURIComponent(token)}`,
      remoteAddress: "192.168.1.50",
    });
    expect(ok.statusCode).toBe(200);
    const setCookie = ok.headers["set-cookie"];
    expect(String(setCookie)).toContain(`wb_lan=${token}`);
    expect(String(setCookie)).toContain("HttpOnly");
  });

  it("带有效 cookie 的局域网请求直接放行", async () => {
    const app = await buildApp({ projectRoot: root });
    const token = getLanToken(root);
    const res = await app.inject({
      method: "GET",
      url: "/api/task/x",
      remoteAddress: "192.168.1.50",
      headers: { cookie: `wb_lan=${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("x-wb-token 请求头同样可作为凭证", async () => {
    const app = await buildApp({ projectRoot: root });
    const token = getLanToken(root);
    const res = await app.inject({
      method: "GET",
      url: "/api/task/x",
      remoteAddress: "192.168.1.50",
      headers: { "x-wb-token": token },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/lan-info", () => {
  it("本机可读，返回 token 与二维码结构", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({ method: "GET", url: "/api/lan-info" });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.success).toBe(true);
    expect(j.data.token).toBe(getLanToken(root));
    expect(typeof j.data.hasLan).toBe("boolean");
    if (j.data.addresses.length) {
      const a = j.data.addresses[0];
      expect(a.url).toContain(`http://${a.address}:`);
      expect(a.qr.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("局域网无 token 不可读（避免泄露 token）", async () => {
    const app = await buildApp({ projectRoot: root });
    const res = await app.inject({
      method: "GET",
      url: "/api/lan-info",
      remoteAddress: "192.168.1.50",
    });
    expect(res.statusCode).toBe(401);
  });
});
