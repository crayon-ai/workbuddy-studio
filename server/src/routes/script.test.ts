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

const { buildApp } = await import("../app.js");
const { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const envPath = "./.env.script.test";
const FORMULAS = [
  { id: "f2", name: "清单体种草" },
  { id: "f5", name: "保姆级教程" },
];
const STRUCT_MD = [
  "## 赛道",
  "美食",
  "",
  "## 公式",
  "f2",
  "",
  "## 匹配理由",
  "数字痛点开场先立预期，三碗面并列清单直给，结尾提问拉评论 + 收藏钩，命中清单体种草。",
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

  it("拆解完成：识别赛道 + 匹配公式 + 原文脚本，产物落在账号目录", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string, _opts, onProgress) => {
      capturedPrompt = prompt;
      // 真实链路里 agent 会持续上报进度（内部走 getTask 更新任务表），模拟以守住该路径
      if (onProgress) {
        onProgress({ step: "正在读取素材原文…" });
        onProgress({ detail: "curl https://x.com" });
      }
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_MD);
      writeFileSync(join(workDir, "原文.md"), "# 原文");
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_MD, "原文.md": "# 原文" } };
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
    expect(body.data.result.script).toContain("番茄肥牛面");
    // prompt 应内嵌公式清单 + 识别与匹配指令
    expect(capturedPrompt).toContain("【公式清单】");
    expect(capturedPrompt).toContain("- f2｜清单体种草");
    expect(capturedPrompt).toContain("必须且只能选一个");
    expect(capturedPrompt).toContain("## 脚本");
    expect(existsSync(join(projectRoot, "data", "accounts", "acc1", "scripts", taskId))).toBe(true);
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("AI 返回的公式不在清单内 → failed，不伪装成功", async () => {
    const { runSkill } = await import("../skill-runner.js");
    const badMd = STRUCT_MD.replace("f2", "f99");
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

  it("传 reuseTaskId 且爆款原文存在 → prompt 指向已有目录且禁止重新下载", async () => {
    const { runSkill } = await import("../skill-runner.js");
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
    writeFileSync(join(rawDir, "正文.md"), "# 已有正文");

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
    expect(capturedPrompt).toContain("禁止任何网络请求重新下载");
    expect(capturedPrompt).not.toContain("模式 B：全新抓取");

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
    writeFileSync(join(rawDir, "正文.md"), "# 已有正文");
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

  it("无任何可复用原文 → 走全新抓取模式，prompt 指向原文库目录", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
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
    rmSync(projectRoot, { recursive: true, force: true });
    await app.close();
  });

  it("reuseTaskId 指向不存在/别的账号的目录 → 安全回落到全新抓取", async () => {
    const { runSkill } = await import("../skill-runner.js");
    let capturedPrompt = "";
    vi.mocked(runSkill).mockImplementationOnce(async (_s, prompt: string, workDir: string) => {
      capturedPrompt = prompt;
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "structure.md"), STRUCT_MD);
      return { ok: true, text: "done", artifacts: { "structure.md": STRUCT_MD } };
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
    expect(capturedPrompt).toContain("模式 B：全新抓取");
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
