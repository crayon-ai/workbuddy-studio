import { describe, it, expect } from "vitest";
import { parseTitles, parseTeardown } from "./parse.js";

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
