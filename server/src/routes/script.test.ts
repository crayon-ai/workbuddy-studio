import { describe, it, expect, beforeEach, vi } from "vitest";

// mock runSkill：按用例动态写产物到 workDir（模拟 agent 落盘）
vi.mock("../skill-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skill-runner.js")>();
  return {
    collectMarkdown: actual.collectMarkdown,
    runSkill: vi.fn(async (_skill: string, _prompt: string, _workDir: string) => ({
      ok: true,
      text: "done",
      artifacts: {},
    })),
  };
});

// mock 后端直连抓取：默认成功并把 正文.md 写进原文库目录（模拟 tear-fetch 落盘）；
// 纯函数（平台识别/解析）保留真实实现供单测使用
vi.mock("../tear-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tear-fetch.js")>();
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    ...actual,
    fetchMaterialRaw: vi.fn(async (_url: string, dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "正文.md"), RAW_BODY_MD);
      return {
        ok: true,
        platform: "xhs" as const,
        gots: { body: true, images: 0, video: false, transcript: false },
        note: "mock：正文",
      };
    }),
  };
});

const { buildApp } = await import("../app.js");
const { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const envPath = "./.env.script.test";
const FORMULAS = [
  { id: "f2", name: "清单体种草" },
  { id: "f5", name: "保姆级教程" },
];
// 后端直连抓取落盘的原文正文（fetchMaterialRaw mock 写入原文库）
const RAW_BODY_MD = [
  "# 3 碗深夜面条",
  "",
  "打工人下班是不是只想瘫着？这 3 碗面，10 分钟出锅，锅都只用洗一个。",
  "",
  "第一碗，番茄肥牛面：先炒番茄出沙，肥牛扔进去，水开下面。",
  "你最想先试哪一碗？评论区告诉我。",
].join("\n");
// agent 产物（识别与匹配三节，无脚本——脚本由后端拼接）
const STRUCT_ANALYZE_MD = [
  "## 赛道",
  "美食",
  "",
  "## 公式",
  "f2",
  "",
  "## 匹配理由",
  "数字痛点开场先立预期，三碗面并列清单直给，结尾提问拉互动 + 收藏钩，命中清单体种草。",
].join("\n");
// agent 自带脚本节的完整产物（兼容路径：装配时不再追加）
const STRUCT_MD = [
  STRUCT_ANALYZE_MD,
  "",
  "## 脚本",
  "打工人下班是不是只想瘫着？这 3 碗面，10 分钟出锅，锅都只用洗一个。",
  "",
  "第一碗，番茄肥牛面：先炒番茄出沙，肥牛扔进去，水开下面。",
  "你最想先试哪一碗？评论区告诉我。",
].join("\n");

const SCRIPT_MD = [
  "## 标题",
  "打工人 15 分钟极简晚餐：记住三个公式",
  "",
  "## 正文",
  "下班到家七点多，外卖吃腻了对吧？今天不讲菜谱，讲三个公式。",
  "",
  "公式一，水开就能吃：番茄肥牛面，水开下面，一碗热乎的就有了。",
  "公式二，让锅替你上班：电饭煲焖饭，早上放料，晚上开盖。",
].join("\n");

async function waitDone(app: Awaited<ReturnType<typeof buildApp>>, taskId: string) {
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: "GET", url: `/api/task/${taskId}` });
    const body = JSON.parse(r.body);
    if (body.data?.status === "done" || body.data?.status === "failed") return body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("任务未在超时内完成");
}

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  rmSync(envPath, { force: true });
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.clearAllMocks();
});

describe("POST /api/script/tear", () => {
  it("无效 url / 公式清单缺失 / 未配置 key 返回失败", async () => {
    const app = await buildApp({ envPath });
    const bad = await app.inject({ method: "POST", url: "/api/script/tear", payload: { url: "not-a-url" } });
    expect(JSON.parse(bad.body).success).toBe(false);
    const noF = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/a", formulas: [] },
    });
    expect(JSON.parse(noF.body).error).toBe("公式清单缺失，请刷新页面后重试");
    delete process.env.ANTHROPIC_API_KEY;
    const noKey = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/a", formulas: FORMULAS },
    });
    expect(JSON.parse(noKey.body).error).toBe("未配置 API key");
    await app.close();
  });

  it("拆解完成：后端抓正文 + agent 识别三节 + 后端拼接脚本，产物落在账号目录", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string, _opts, onProgress) => {
      capturedPrompt = prompt;
      // 真实链路里 agent 会持续上报进度（内部走 getTask 更新任务表），模拟以守住该路径
      if (onProgress) {
        onProgress({ step: "AI 识别与匹配中…" });
        onProgress({ detail: "Read 正文.md" });
      }
      // agent 只写识别三节（无脚本），脚本由后端从原文库拼接
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_ANALYZE_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_ANALYZE_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-script-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://www.xiaohongshu.com/explore/s1", title: "T", accountId: "acc1", formulas: FORMULAS },
    });
    const taskId = JSON.parse(post.body).data.taskId;
    const body = await waitDone(app, taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.track).toBe("美食");
    expect(body.data.result.fId).toBe("f2");
    expect(body.data.result.why).toContain("清单体");
    // 脚本来自后端拼接的原文正文（含正文原文文本），而非 agent 抄写
    expect(body.data.result.script).toContain("番茄肥牛面");
    expect(body.data.result.script).not.toContain("# 3 碗深夜面条");
    // prompt 应内嵌公式清单 + 识别与匹配指令 + 不抄脚本约束
    expect(capturedPrompt).toContain("识别与匹配");
    expect(capturedPrompt).toContain("【公式清单】");
    expect(capturedPrompt).toContain("- f2｜清单体种草");
    expect(capturedPrompt).toContain("必须且只能选一个");
    expect(capturedPrompt).toContain("不要写「## 脚本」");
    expect(existsSync(join(projectRoot, "data", "accounts", "acc1", "scripts", taskId))).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("AI 返回的公式不在清单内 → failed，不伪装成功", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const badMd = STRUCT_ANALYZE_MD.replace("f2", "f99");
    vi.mocked(runSkill).mockImplementationOnce(async (_s, _p, workDir: string) => {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), badMd);
      return { ok: true, text: "done", artifacts: { "structure.md": badMd } };
    });
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://www.xiaohongshu.com/explore/bad-f", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("未匹配到公式清单内的公式");
    await app.close();
  });

  it("skill 成功但未产出 structure.md（如抓取失败如实停止）→ failed，不伪装成功", async () => {
    const { runSkill } = await import("../skill-runner.js");
    vi.mocked(runSkill).mockImplementationOnce(async () => ({ ok: true, text: "抓取失败", artifacts: {} }));
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://www.xiaohongshu.com/explore/fail", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("未能读取到素材原文");
    await app.close();
  });
});

describe("POST /api/script/gen", () => {
  it("口水话为空返回失败", async () => {
    const app = await buildApp({ envPath });
    const r = await app.inject({ method: "POST", url: "/api/script/gen", payload: { mouth: "  " } });
    expect(JSON.parse(r.body).success).toBe(false);
    await app.close();
  });

  it("生成完成：解析 script.md 分段，无参考也能出通用骨架", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "script.md"), SCRIPT_MD);
      return { ok: true, text: "done", artifacts: { "script.md": SCRIPT_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-scriptgen-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/gen",
      payload: {
        topic: "极简晚餐",
        mouth: "想写 15 分钟晚餐",
        style: "真诚分享",
        form: "口播视频",
        len: "60秒",
        accountId: "default",
      },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("done");
    expect(body.data.result.title).toContain("三个公式");
    expect(body.data.result.text).toContain("下班到家");
    expect(body.data.result.text).toContain("公式二");
    // 无参考时 prompt 应含通用爆款节奏兜底
    expect(capturedPrompt).toContain("通用爆款节奏");
    expect(existsSync(join(projectRoot, "data", "accounts", "default", "scripts"))).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("有参考时 prompt 注入参考素材脚本全文 + 情绪/结构/爆点学习指引 + 护栏；参考单选只取第一条", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "script.md"), SCRIPT_MD);
      return { ok: true, text: "done", artifacts: { "script.md": SCRIPT_MD } };
    });
    const app = await buildApp({ envPath });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/gen",
      payload: {
        mouth: "口水话",
        refs: [
          {
            title: "3 碗深夜面条",
            author: "@小食堂日记",
            track: "美食",
            formula: "清单体种草",
            why: "数字痛点开场 + 三碗面并列直给 + 收藏钩",
            script: "打工人下班是不是只想瘫着？这 3 碗面，10 分钟出锅。\n第一碗，番茄肥牛面……",
          },
          {
            // 第二条参考应被忽略（单选）
            title: "一个人旅行 7 天",
            formula: "账单实证型",
            script: "一个人在大理躺了 7 天，总共花了 2680。",
          },
          {
            // 没带脚本的参考应被路由过滤，不进 prompt
            title: "空参考",
            formula: "极简三段式引流",
          },
        ],
      },
    });
    await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(capturedPrompt).toContain("【参考 · 素材脚本】");
    expect(capturedPrompt).toContain("《3 碗深夜面条》（@小食堂日记） · 赛道：美食 · 命中公式：清单体种草");
    expect(capturedPrompt).toContain("打工人下班是不是只想瘫着？");
    // 单选：第二条与空参考都不出现
    expect(capturedPrompt).not.toContain("一个人旅行 7 天");
    expect(capturedPrompt).not.toContain("空参考");
    expect(capturedPrompt).not.toContain("辅参考");
    expect(capturedPrompt).toContain("- 情绪：");
    expect(capturedPrompt).toContain("- 结构：");
    expect(capturedPrompt).toContain("- 爆点：");
    expect(capturedPrompt).toContain("不要搬进脚本");
    expect(capturedPrompt).toContain("【补：");
    await app.close();
  });
});

describe("parseScriptGen（整篇式 + 旧分段兼容）", () => {
  it("新格式：标题 + 整篇正文", async () => {
    const { parseScriptGen } = await import("../parse.js");
    const r = parseScriptGen({ "script.md": SCRIPT_MD });
    expect(r).not.toBeNull();
    expect(r!.title).toContain("三个公式");
    expect(r!.text).toContain("下班到家");
    expect(r!.text).toContain("公式二");
    expect(r!.text).not.toContain("##");
  });

  it("旧分段格式：各段正文拼接为整篇，段名/套用不混入", async () => {
    const { parseScriptGen } = await import("../parse.js");
    const old = [
      "## 结构",
      "三段式",
      "",
      "## 段1",
      "- 段名：钩子 · 痛点+数字",
      "- 套用：数字冲击",
      "- 正文：",
      "打工人，先别划走。",
      "",
      "## 段2",
      "- 段名：主体",
      "- 套用：清单体",
      "- 正文：",
      "公式一：一锅端。",
    ].join("\n");
    const r = parseScriptGen({ "script.md": old });
    expect(r).not.toBeNull();
    expect(r!.text).toContain("打工人，先别划走。");
    expect(r!.text).toContain("公式一：一锅端。");
    expect(r!.text).not.toContain("钩子");
    expect(r!.text).not.toContain("数字冲击");
  });
});

// ===== 原文复用：同一素材不重复下载 =====
describe("原文复用（跨链路 + 原文库）", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("传 reuseTaskId 且爆款原文存在 → prompt 指向已有目录且禁止重新下载，不走后端抓取", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const { fetchMaterialRaw } = await import("../tear-fetch.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-reuse-"));
    // 造一个已有的爆款拆解产物：爆款原文/<标题>/正文.md
    const rawDir = join(projectRoot, "data", "accounts", "default", "teardowns", "td-1", "爆款原文", "测试标题");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "正文.md"), "# 已有正文\n打工人下班是不是只想瘫着？这 3 碗面，10 分钟出锅。");

    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/mat", title: "T", reuseTaskId: "td-1", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("done");
    expect(capturedPrompt).toContain("模式 A：复用已有原文");
    expect(capturedPrompt).toContain(join(rawDir, ""));
    expect(capturedPrompt).toContain("禁止任何网络请求");
    expect(capturedPrompt).not.toContain("模式 B：全新抓取");
    // 复用路径不应触发后端抓取
    expect(vi.mocked(fetchMaterialRaw)).not.toHaveBeenCalled();

    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("teardown 完成写入索引后，同 url 的脚本拆解自动复用（不传 reuseTaskId）", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const { recordTeardownSource } = await import("./script.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-idx-"));
    const rawDir = join(projectRoot, "data", "accounts", "default", "teardowns", "td-2", "爆款原文", "某笔记");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "正文.md"), "# 某笔记正文\n一个人在大理躺了 7 天，总共花了 2680，账单全部贴给你看。");
    recordTeardownSource(projectRoot, "default", "https://x.com/same-mat", "td-2");

    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/same-mat", title: "S", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("done");
    expect(capturedPrompt).toContain("模式 A：复用已有原文");
    expect(capturedPrompt).toContain("某笔记");

    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("无任何可复用原文且后端直连失败 → 回退 agent 全新抓取模式", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const { fetchMaterialRaw } = await import("../tear-fetch.js");
    let capturedPrompt = "";
    vi.mocked(fetchMaterialRaw).mockImplementationOnce(async () => ({
      ok: false,
      platform: "web" as const,
      gots: { body: false, images: 0, video: false, transcript: false },
      note: "mock：未获得有效内容",
    }));
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      // 兜底路径 agent 可自带脚本节（装配时检测到已含则不再追加）
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-fresh-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/fresh", title: "F", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("done");
    expect(capturedPrompt).toContain("模式 B：全新抓取");
    expect(capturedPrompt).toContain("原文库目录");
    expect(capturedPrompt).toContain("图片内文字");
    expect(capturedPrompt).toContain("视频逐字稿");
    expect(capturedPrompt).toContain("评论区不抓取");
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reuseTaskId 指向不存在/别的账号的目录 → 安全回落到后端直连抓取", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const { fetchMaterialRaw } = await import("../tear-fetch.js");
    let capturedPrompt = "";
    let fetchedUrl = "";
    vi.mocked(fetchMaterialRaw).mockImplementationOnce(async (url: string, dir: string) => {
      fetchedUrl = url;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "正文.md"), RAW_BODY_MD);
      return { ok: true, platform: "web" as const, gots: { body: true, images: 0, video: false, transcript: false }, note: "mock" };
    });
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_ANALYZE_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_ANALYZE_MD } };
    });
    const projectRoot = mkdtempSync(join(tmpdir(), "wb-fallback-"));
    const app = await buildApp({ envPath, projectRoot });
    const post = await app.inject({
      method: "POST",
      url: "/api/script/tear",
      payload: { url: "https://x.com/gone", reuseTaskId: "not-exist", formulas: FORMULAS },
    });
    const body = await waitDone(app, JSON.parse(post.body).data.taskId);
    expect(body.data.status).toBe("done");
    expect(fetchedUrl).toBe("https://x.com/gone");
    expect(capturedPrompt).toContain("模式 A：原文已由后端抓取归档");
    // 后端从直连抓到的正文拼接脚本
    expect(body.data.result.script).toContain("番茄肥牛面");
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });
});

describe("parseScriptTear（识别+匹配新格式）", () => {
  it("赛道/公式/理由/脚本 完整解析，兼容加粗与空行，脚本跨多段保留换行", async () => {
    const { parseScriptTear } = await import("../parse.js");
    const md = [
      "# structure.md — 《某素材》拆解",
      "",
      "## 赛道",
      "",
      "**AI 工具**",
      "",
      "## 公式",
      "",
      "f5",
      "",
      "## 匹配理由",
      "",
      "先晒成品再分步讲，结尾降门槛扣字，命中保姆级教程。",
      "",
      "## 脚本",
      "给大家分享一个起号 skill。",
      "",
      "第一步，让 AI 认识你。",
      "第二步，把常用做法装成 skill。",
    ].join("\n");
    const r = parseScriptTear({ "structure.md": md });
    expect(r).not.toBeNull();
    expect(r!.track).toBe("AI 工具");
    expect(r!.formula).toBe("f5");
    expect(r!.why).toContain("保姆级教程");
    expect(r!.script).toContain("起号 skill");
    expect(r!.script).toContain("第二步，把常用做法装成 skill。");
  });

  it("脚本为空/缺公式 → null（对应不写 structure.md 的约定）", async () => {
    const { parseScriptTear } = await import("../parse.js");
    expect(parseScriptTear({ "structure.md": ["## 赛道", "美食", "", "## 公式", "f2", "", "## 匹配理由", "x"].join("\n") })).toBeNull();
    expect(parseScriptTear({ "structure.md": ["## 赛道", "美食", "", "## 匹配理由", "x", "", "## 脚本", "正文"].join("\n") })).toBeNull();
  });
});

// ===== 脚本后端拼接（agent 不抄原文） =====
describe("chooseScriptText / appendScriptSection", () => {
  it("逐字稿优先于正文；去掉文件头部 markdown 标题行", async () => {
    const { chooseScriptText } = await import("./script.js");
    const dir = mkdtempSync(join(tmpdir(), "wb-scriptsrc-"));
    writeFileSync(join(dir, "正文.md"), "# 正文标题\n\n图文正文内容足够长，用来在没有逐字稿时兜底拼接。");
    writeFileSync(join(dir, "逐字稿.md"), "# 逐字稿\n\n第一句口播内容。\n第二句口播内容。");
    const script = chooseScriptText(dir)!;
    expect(script).toContain("第一句口播内容。");
    expect(script).not.toContain("# 逐字稿");
    rmSync(dir, { recursive: true, force: true });
  });

  it("structure.md 缺「## 脚本」→ 从原文库拼接；已含 → 不动；原文库空 → 不动", async () => {
    const { appendScriptSection } = await import("./script.js");
    const workDir = mkdtempSync(join(tmpdir(), "wb-wasm-"));
    const rawDir = mkdtempSync(join(tmpdir(), "wb-wraw-"));
    // 缺脚本节 → 拼接
    writeFileSync(join(workDir, "structure.md"), STRUCT_ANALYZE_MD);
    writeFileSync(join(rawDir, "逐字稿.md"), "# 逐字稿\n\n番茄肥牛面先炒出沙，水开下面，十分钟就能出锅。");
    appendScriptSection(workDir, rawDir);
    const appended = readFileSync(join(workDir, "structure.md"), "utf8");
    expect(appended).toContain("## 脚本");
    expect(appended).toContain("番茄肥牛面");
    expect(appended).toContain("## 赛道");
    // 已含脚本节 → 保持原样（不重复追加）
    const before = readFileSync(join(workDir, "structure.md"), "utf8");
    appendScriptSection(workDir, rawDir);
    expect(readFileSync(join(workDir, "structure.md"), "utf8")).toBe(before);
    // 原文库无可用内容 → 不动
    const workDir2 = mkdtempSync(join(tmpdir(), "wb-wasm2-"));
    const rawDir2 = mkdtempSync(join(tmpdir(), "wb-wraw2-"));
    writeFileSync(join(workDir2, "structure.md"), STRUCT_ANALYZE_MD);
    appendScriptSection(workDir2, rawDir2);
    expect(readFileSync(join(workDir2, "structure.md"), "utf8")).toBe(STRUCT_ANALYZE_MD);
    for (const d of [workDir, rawDir, workDir2, rawDir2]) rmSync(d, { recursive: true, force: true });
  });
});

// ===== tear-fetch 纯函数（平台识别 + 页面 JSON 解析） =====
describe("tear-fetch 纯函数", () => {
  it("detectPlatform / bvidOf / xhsNoteId / douyinId", async () => {
    const tf = await import("../tear-fetch.js");
    expect(tf.detectPlatform("https://www.bilibili.com/video/BV12DT762EVe")).toBe("bili");
    expect(tf.detectPlatform("https://www.xiaohongshu.com/explore/abc")).toBe("xhs");
    expect(tf.detectPlatform("https://v.douyin.com/xxx/")).toBe("douyin");
    expect(tf.detectPlatform("https://example.com/a")).toBe("web");
    expect(tf.bvidOf("https://www.bilibili.com/video/BV12DT762EVe/?p=1")).toBe("BV12DT762EVe");
    expect(tf.bvidOf("https://example.com/")).toBeNull();
    expect(tf.xhsNoteId("https://www.xiaohongshu.com/discovery/item/65f0a123?xsec_token=abc")).toBe("65f0a123");
    expect(tf.douyinId("https://www.douyin.com/video/7350123456789012345")).toBe("7350123456789012345");
  });

  it("parseEmbeddedJson：undefined 值转 null，字符串里的 undefined 不被破坏", async () => {
    const tf = await import("../tear-fetch.js");
    const j = tf.parseEmbeddedJson<{ a: unknown; b: unknown[]; d: string }>('{"a":undefined,"b":[undefined,1],"d":"变量是undefined哦"}')!;
    expect(j.a).toBeNull();
    expect(j.b[0]).toBeNull();
    expect(j.b[1]).toBe(1);
    expect(j.d).toBe("变量是undefined哦");
    expect(tf.parseEmbeddedJson("not json")).toBeNull();
  });

  it("t2s：繁体转简体，表外字符原样保留", async () => {
    const tf = await import("../tear-fetch.js");
    expect(tf.t2s("我都幫大家整理好了，前後試過上百個Skill")).toBe("我都帮大家整理好了，前后试过上百个Skill");
    expect(tf.t2s("把效果圖直接轉換成可編輯的原檔")).toBe("把效果图直接转换成可编辑的原檔".replace("檔", "档"));
    expect(tf.t2s("abc 123。")).toBe("abc 123。");
  });

  it("extractXhsNote / xhsImageUrls：从 __INITIAL_STATE__ 提取笔记与图片", async () => {
    const tf = await import("../tear-fetch.js");
    const html =
      '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"65f0a123":{"note":{"title":"3 碗深夜面条","desc":"打工人看过来","type":"normal","user":{"nickname":"小食堂"},"interactInfo":{"liked":"1.2万"},"imageList":[{"urlDefault":"https://img.xhs/1.webp"},{"urlDefault":""},{"infoList":[{"url":"https://img.xhs/2a"},{"url":"https://img.xhs/2b"}]}]}}}}}</script>';
    const note = tf.extractXhsNote(html)!;
    expect(note.title).toBe("3 碗深夜面条");
    expect(note.user.nickname).toBe("小食堂");
    const urls = tf.xhsImageUrls(note);
    expect(urls).toEqual(["https://img.xhs/1.webp", "https://img.xhs/2b"]);
    expect(tf.extractXhsNote("<html>没有状态数据</html>")).toBeNull();
  });
});
