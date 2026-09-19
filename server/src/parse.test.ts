import { describe, it, expect } from "vitest";
import {
  parseTitles,
  parseTeardown,
  parseProfile,
  parseDeepReview,
  backfillInspUrls,
  type Insp,
} from "./parse.js";
import type { SourceItem } from "./sources.js";

describe("parseTitles", () => {
  it("解析 ```json 代码块里的数组", () => {
    const txt = '前言\n```json\n[{"t":"标题1","mech":"好奇","reason":"理由"}]\n```\n结尾';
    const r = parseTitles(txt);
    expect(r).toHaveLength(1);
    expect(r[0].t).toBe("标题1");
  });

  it("解析裸 JSON 数组", () => {
    expect(parseTitles('[{"t":"A"},{"t":"B"}]')).toHaveLength(2);
  });

  it("无 JSON 时返回空数组", () => {
    expect(parseTitles("纯文本无结构")).toEqual([]);
  });

  it("过滤无 t 字段或 t 非字符串的项", () => {
    expect(parseTitles('[{"t":"A"},{"x":1},{"t":123}]')).toHaveLength(1);
  });
});

describe("parseTeardown", () => {
  const noteInfo = [
    "# 测试笔记",
    "## 作者",
    "- 昵称：测试作者",
    "## 笔记元数据",
    "- 发布时间戳：1784876760000（2026-08）",
    "## 话题标签",
    "- #提高工作效率[话题]#",
    "- #AI新手村[话题]#",
    "## 互动数据",
    "- 点赞：2594",
    "- 收藏：4087",
    "- 评论：45",
    "- 分享：902",
  ].join("\n");

  const report = "# 测试笔记\n\n## 标题为什么吸引人\n这是拆解内容A\n\n## 开头钩子\n内容B";

  it("从笔记信息.md 提取元数据 + 从 AI拆解 提取章节", () => {
    const r = parseTeardown({
      "笔记信息.md": noteInfo,
      "AI爆款拆解-测试笔记.md": report,
    });
    expect(r.meta.title).toBe("测试笔记");
    expect(r.meta.author).toBe("测试作者");
    expect(r.meta.date).toBe("2026-08");
    expect(r.meta.likes).toBe("2594");
    expect(r.meta.favs).toBe("4087");
    expect(r.meta.comments).toBe("45");
    expect(r.meta.shares).toBe("902");
    expect(r.meta.tags).toEqual(["提高工作效率", "AI新手村"]);
    expect(r.sections["标题为什么吸引人"]).toContain("拆解内容A");
    expect(r.sections["开头钩子"]).toContain("内容B");
    expect(r.reportFile).toBe("AI爆款拆解-测试笔记.md");
  });

  it("只有报告无 frontmatter 时，从报告 # 标题 提取 title，无互动数据", () => {
    const r = parseTeardown({ "AI爆款拆解-x.md": "# x\n## 维度A\n内容" });
    expect(r.meta.title).toBe("x");
    expect(r.meta.likes).toBeUndefined();
    expect(r.sections["维度A"]).toContain("内容");
  });

  it("从正文.md（list 格式）提取元数据", () => {
    const r = parseTeardown({
      "正文.md": [
        "# 1分钟学会Mac三开新版本微信",
        "- 平台：小红书",
        "- 作者：Fede（跨境电商AI版）",
        "- 发布时间：2026-07-10 10:06:01",
        "- 互动数据：赞 317 / 收藏 263 / 评论 123 / 分享 220",
      ].join("\n"),
      "AI爆款拆解-1分钟学会Mac三开新版本微信.md": "# x\n## 维度A\n内容",
    });
    expect(r.meta.title).toBe("1分钟学会Mac三开新版本微信");
    expect(r.meta.author).toBe("Fede（跨境电商AI版）");
    expect(r.meta.date).toBe("2026-07-10 10:06:01");
    expect(r.meta.likes).toBe("317");
    expect(r.meta.favs).toBe("263");
    expect(r.meta.comments).toBe("123");
    expect(r.meta.shares).toBe("220");
  });

  it("从 AI拆解报告 frontmatter 兜底提取元数据", () => {
    const r = parseTeardown({
      "AI爆款拆解-x.md":
        "---\n标题: 测试标题\n作者: 张三\n互动: 赞100 / 收藏50 / 评论10\n拆解日期: 2026-08-11\n---\n\n# 测试标题\n## 维度A\n内容",
    });
    expect(r.meta.author).toBe("张三");
    expect(r.meta.likes).toBe("100");
    expect(r.meta.favs).toBe("50");
    expect(r.meta.date).toBe("2026-08-11");
  });

  it("无拆解报告时返回空 sections", () => {
    expect(parseTeardown({})).toEqual({ meta: {}, sections: {}, raw: "" });
  });

  it("忽略非 AI爆款拆解 开头的 md", () => {
    const r = parseTeardown({ "README.md": "# hi" });
    expect(r.raw).toBe("");
  });
});

describe("parseProfile", () => {
  const MD = [
    "- track: 职场效率工具测评，面向自媒体新手的 AI 工作流",
    "- pillars: AI 工具实战 | 效率方法论 | 小红书运营",
    "- topics: AI 标题技巧 | 素材库搭建 | 灵感工作流",
    "- shift: 从工具测评转向工作流方法论",
    "- keywords: AI 工作台 | 效率工具 | 内容创作 | 灵感管理",
  ].join("\n");

  it("正常解析画像各字段", () => {
    const p = parseProfile({ "profile.md": MD });
    expect(p).not.toBeNull();
    expect(p!.track).toContain("效率工具");
    expect(p!.pillars).toHaveLength(3);
    expect(p!.topics[0]).toBe("AI 标题技巧");
    expect(p!.shift).toContain("方法论");
    expect(p!.keywords).toHaveLength(4);
  });

  it("字段缺失给默认空数组", () => {
    const p = parseProfile({ "profile.md": "- 赛道: x\n- keywords: a | b" });
    expect(p!.pillars).toEqual([]);
    expect(p!.topics).toEqual([]);
  });

  it("关键词为空返回 null（视为画像失败）", () => {
    expect(parseProfile({ "profile.md": "- 赛道: x" })).toBeNull();
  });

  it("找不到 profile 产物返回 null", () => {
    expect(parseProfile({ "inspirations.md": "## 1" })).toBeNull();
  });

  // 实测故障形态（2026-08-23 fa8049a8/91e82129）：agent 无视格式约束，
  // 写成自由格式报告——key 行无 `- ` 前缀、pillars/topics/keywords 是多行列表。
  it("解析自由格式报告：无前缀 key 行 + 多行列表（fa8049a8 形态）", () => {
    const freeForm = [
      "track: AI-native工作方式与技术内容创作",
      "",
      "pillars:",
      "- AI工具链与工作流（coding agent、skill设计）",
      "- 技术内容创作方法论",
      "",
      "topics:",
      "- AI-native组织与团队协作",
      "- Coding agent实战与skill设计",
      "",
      "shift: 从个人影响力构建到组织级AI落地",
      "",
      "keywords:",
      "- AI-native团队",
      "- Coding agent",
      "- Build in public",
      "- HTML slides",
    ].join("\n");
    const p = parseProfile({ "profile.md": freeForm });
    expect(p).not.toBeNull();
    expect(p!.track).toContain("AI-native");
    expect(p!.pillars).toHaveLength(2);
    expect(p!.pillars[0]).toBe("AI工具链与工作流（coding agent、skill设计）");
    expect(p!.topics).toHaveLength(2);
    expect(p!.shift).toContain("组织级AI落地");
    expect(p!.keywords).toEqual(["AI-native团队", "Coding agent", "Build in public", "HTML slides"]);
  });

  it("解析自由格式报告：### 标题形态 key + 编号列表 + **加粗**清洗（91e82129 形态）", () => {
    const report = [
      "# 张咋啦 - 博主画像分析",
      "",
      "### track: AI原生工作方式与开发者内容创作",
      "聚焦AI-native开发实践。",
      "",
      "### pillars:",
      "1. **AI-native工作方式与组织变革** (35%)",
      "2. **开发者工具与开源实践** (30%)",
      "",
      "### keywords:",
      "- AI-native workflow",
      "- HTML slides & video production",
      "- **Coding agent** & automation",
    ].join("\n");
    const p = parseProfile({ "profile.md": report });
    expect(p).not.toBeNull();
    expect(p!.track).toBe("AI原生工作方式与开发者内容创作");
    expect(p!.pillars).toEqual(["AI-native工作方式与组织变革", "开发者工具与开源实践"]);
    expect(p!.keywords).toEqual([
      "AI-native workflow",
      "HTML slides & video production",
      "Coding agent & automation",
    ]);
  });
});

describe("parseDeepReview（深度复盘报告解析）", () => {
  const REPORT = [
    "# AI深度复盘-我的笔记",
    "",
    "## 数据对比总览",
    "| 笔记 | 赞 | 藏 | 评 | 发布 |",
    "| --- | --- | --- | --- | --- |",
    "| 我的 | 200 | 800 | 30 | 08-20 |",
    "| 对标A | 20000 | 15000 | 800 | 08-18 |",
    "",
    "## 差距归因",
    "标题钩子差距……",
    "",
    "## 可执行建议",
    "1. 建议一",
    "2. 建议二",
    "",
    "## 可复用经验候选",
    "- 数字+场景标题最有效",
    "- 正文前 3 行给结论",
  ].join("\n");

  it("识别 AI深度复盘 报告并提取 sections", () => {
    const r = parseDeepReview({ "AI深度复盘-我的笔记.md": REPORT });
    expect(r).not.toBeNull();
    expect(r!.reportFile).toBe("AI深度复盘-我的笔记.md");
    expect(Object.keys(r!.sections).length).toBe(4);
    expect(r!.sections["差距归因"]).toContain("标题钩子");
  });

  it("无报告文件返回 null", () => {
    expect(parseDeepReview({ "其他.md": "x" })).toBeNull();
  });

  it("sections 按行首 ## 切分，内容进对应 section", () => {
    const r = parseDeepReview({ "AI深度复盘-x.md": REPORT })!;
    expect(r!.sections["可复用经验候选"]).toContain("- 数字+场景标题最有效");
  });

  it("## 节无内容（标题后无换行）时 section 值为空串", () => {
    const r = parseDeepReview({ "AI深度复盘-x.md": "# t\n\n## 差距归因" });
    expect(r!.sections["差距归因"]).toBe("");
  });
});

describe("backfillInspUrls", () => {
  const items: SourceItem[] = [
    { pf: "bili", pfn: "B站", title: "DeepSeek V4.1 实测：277 Token/s，快得有点吓人", author: "神烦老狗", url: "https://b23.tv/a1", summary: "", heat: "12.9万", pub: "3 天前" },
    { pf: "weixin", pfn: "微信", title: "DeepSeek 用 1/15 的价格,干掉了编码 AI 的定价权", author: "茶萃Tea", url: "https://mp.weixin.qq.com/s/b2", summary: "", heat: "", pub: "今天" },
    { pf: "weixin", pfn: "微信", title: "DeepSeek 用 1/15 的价格,干掉了编码 AI 的定价权（转载）", author: "其他人", url: "https://mp.weixin.qq.com/s/b3", summary: "", heat: "", pub: "今天" },
    { pf: "bili", pfn: "B站", title: "完全不相关的另一条视频", author: "路人", url: "https://b23.tv/a4", summary: "", heat: "", pub: "1 天前" },
  ];

  const insp = (over: Partial<Insp>): Insp => ({
    pf: "bili",
    pfn: "B站",
    author: "",
    pub: "",
    t: "",
    s: "",
    why: [],
    m: [],
    cands: [],
    ...over,
  });

  it("缺 url 时按归一化标题精确匹配回填（标点/空白差异不影响）", () => {
    const out = backfillInspUrls(
      [insp({ pf: "weixin", t: "DeepSeek 用 1/15 的价格，干掉了编码 AI 的定价权" })],
      items
    );
    // 精确级只有一个候选（全角逗号归一化后与 b2 相同），b3 是包含级候选不参与
    expect(out[0].url).toBe("https://mp.weixin.qq.com/s/b2");
  });

  it("agent 截断长标题时按互含匹配回填", () => {
    const out = backfillInspUrls(
      [insp({ pf: "bili", t: "DeepSeek V4.1 实测：277 Token/s" })],
      items
    );
    expect(out[0].url).toBe("https://b23.tv/a1");
  });

  it("同标题不同 url（歧义）时不回填", () => {
    const out = backfillInspUrls([insp({ pf: "bili", t: "完全不相关的另一条视频" })], [
      { ...items[3] },
      { ...items[3], url: "https://b23.tv/a5", author: "别人搬运" },
    ]);
    expect(out[0].url).toBeUndefined();
  });

  it("互含但较短一侧不足 8 字符的误配风险放弃匹配", () => {
    const out = backfillInspUrls([insp({ pf: "bili", t: "DeepSeek" })], items);
    expect(out[0].url).toBeUndefined();
  });

  it("已有 url 的条目保持不变", () => {
    const out = backfillInspUrls([insp({ t: "DeepSeek V4.1 实测：277 Token/s，快得有点吓人", url: "https://keep.me" })], items);
    expect(out[0].url).toBe("https://keep.me");
  });
});
