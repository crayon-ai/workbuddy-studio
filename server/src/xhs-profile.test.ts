import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./reader-fetch.js", () => ({ fetchViaReader: vi.fn() }));

const { fetchBloggerProfile, isXhsProfileUrl, parseProfileFromRender } = await import("./xhs-profile.js");
const { fetchViaReader } = await import("./reader-fetch.js");

/** 复刻 2026-09-22 实抓的主页 Firecrawl 渲染 markdown（无简介账号，2 张卡片）。
 *  关键干扰项都在：页头 logo 链接、封面/作者行（文本含图片标记）、页脚「通知/消息」
 *  链接（指向 /user/profile/ 且带 pc_user，但 href 以 # 锚点结尾）。 */
const FIXTURE_MD = [
  "[![](<Base64-Image-Removed>)](https://www.xiaohongshu.com/explore?channel_type=web_user_page)",
  "",
  "一口柚柚冰",
  "",
  "小红书号：49313106039 IP属地：湖南",
  "",
  "还没有简介",
  "",
  "10+关注",
  "",
  "10+粉丝",
  "",
  "1千+获赞与收藏",
  "",
  "关注",
  "",
  "笔记",
  "",
  "收藏",
  "",
  "[![](https://sns-webpic-qc.xhscdn.com/202609222337/922ed94b/cover1.webp)](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610/?xsec_token=ABhu_Cqz8Lew&xsec_source=pc_user)",
  "",
  "[WorkBuddy 超绝40分钟保姆级教程！](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610/?xsec_token=ABhu_Cqz8Lew&xsec_source=pc_user)",
  "",
  "[![](https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo.webp)\\\\",
  "一口柚柚冰](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610?channel_type=web_user_page&parent_page_channel_type=web_user_board&xsec_token=&xsec_source=pc_note) 1",
  "",
  "[![](https://sns-webpic-qc.xhscdn.com/202609222337/d861e2b4/cover2.webp)](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610/?xsec_token=ABhu_Cqz8Lew&xsec_source=pc_user)",
  "",
  "[WorkBuddy 40分钟超完整保姆级教程！](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610/?xsec_token=ABhu_Cqz8Lew&xsec_source=pc_user)",
  "",
  "[![](https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo.webp)\\\\",
  "一口柚柚冰](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610?channel_type=web_user_page&parent_page_channel_type=web_user_board&xsec_token=&xsec_source=pc_note) 2034",
  "",
  "加载中",
  "",
  "该用户已设置收藏内容不可见",
  "",
  '[通知](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610?xsec_token=ABGMBbU9zALC&xsec_source=pc_user# "通知")',
  "",
  "[消息](https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610?xsec_token=ABGMBbU9zALC&xsec_source=pc_user#)",
].join("\n");

const FIXTURE_META: Record<string, any> = {
  ogTitle: "一口柚柚冰 - 小红书",
  title: "一口柚柚冰 - 小红书",
  description: "一口柚柚冰在「小红书」上有10+位粉丝",
  "og:title": "一口柚柚冰 - 小红书",
};

/** 有简介账号的开头段（栗子Li 实抓样式）：简介多行，后跟「29岁」统计行。 */
const BIO_HEAD = [
  "栗子Li🌰",
  "",
  "小红书号：839158372 IP属地：浙江",
  "",
  "🔍 INFJ职场妈妈 ｜养了一颗板栗🌰",
  '🫶🏻 “上班+带娃+自媒体”三手抓',
  "🌿 亲子Vlog｜女性成长｜0-1自媒体成长",
  "",
  "29岁",
  "",
  "75",
].join("\n");

describe("isXhsProfileUrl", () => {
  it("接受标准主页链接（含 www、http、带 query）", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/5ff0e641")).toBe(true);
    expect(isXhsProfileUrl("http://xiaohongshu.com/user/profile/abc")).toBe(true);
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/user/profile/abc?xsec_token=t")).toBe(true);
  });
  it("接受 App 分享的 xhslink.com 短链", () => {
    expect(isXhsProfileUrl("http://xhslink.com/a/AbCdEfG")).toBe(true);
    expect(isXhsProfileUrl("https://xhslink.com/xyz123")).toBe(true);
  });
  it("拒绝非主页链接", () => {
    expect(isXhsProfileUrl("https://www.xiaohongshu.com/explore/abc")).toBe(false);
    expect(isXhsProfileUrl("https://www.bilibili.com/space/123")).toBe(false);
    expect(isXhsProfileUrl("不是链接")).toBe(false);
    expect(isXhsProfileUrl("")).toBe(false);
  });
});

describe("parseProfileFromRender（渲染 markdown → BloggerProfile）", () => {
  it("解析标题与点赞：封面/作者行/页脚「通知/消息」均不误判为笔记", () => {
    const p = parseProfileFromRender(FIXTURE_MD, FIXTURE_META);
    expect(p.notes).toHaveLength(2);
    expect(p.notes[0]).toEqual({ title: "WorkBuddy 超绝40分钟保姆级教程！", likes: "1" });
    expect(p.notes[1]).toEqual({ title: "WorkBuddy 40分钟超完整保姆级教程！", likes: "2034" });
  });

  it("昵称取自 og 标题并去站名后缀；无简介账号 desc 为 undefined", () => {
    const p = parseProfileFromRender(FIXTURE_MD, FIXTURE_META);
    expect(p.nickname).toBe("一口柚柚冰");
    expect(p.desc).toBeUndefined();
  });

  it("提取多行简介：IP 属地行之后、以数字开头的统计行（如 29岁）之前", () => {
    const meta = { ogTitle: "栗子Li🌰 - 小红书" };
    const p = parseProfileFromRender(BIO_HEAD + "\n" + FIXTURE_MD, meta);
    expect(p.nickname).toBe("栗子Li🌰");
    expect(p.desc).toBe("🔍 INFJ职场妈妈 ｜养了一颗板栗🌰 🫶🏻 “上班+带娃+自媒体”三手抓 🌿 亲子Vlog｜女性成长｜0-1自媒体成长");
  });

  it("点赞缺失时 likes 为 undefined；支持「1.2万」格式", () => {
    const md = [
      "小红书号：1 IP属地：上海",
      "[标题甲](https://www.xiaohongshu.com/user/profile/abc/?xsec_token=t&xsec_source=pc_user)",
      "[标题乙](https://www.xiaohongshu.com/user/profile/abc/?xsec_token=t&xsec_source=pc_user)",
      "[![](a.webp)\\\\",
      "昵称](https://www.xiaohongshu.com/user/profile/abc?xsec_token=&xsec_source=pc_note) 1.2万",
    ].join("\n");
    const p = parseProfileFromRender(md, { title: "测试 - 小红书" });
    expect(p.notes[0]).toEqual({ title: "标题甲", likes: undefined });
    expect(p.notes[1]).toEqual({ title: "标题乙", likes: "1.2万" });
  });

  it("登录墙/空主页 markdown（无卡片）解析出 0 条笔记", () => {
    const p = parseProfileFromRender("登录即可查看 Ta 的笔记\nTA 还没有发布任何内容哦", {});
    expect(p.notes).toHaveLength(0);
  });

  it("智谱纯文本式卡片：封面图行 → 标题行 → 头像图行 → 作者行 → 点赞行", () => {
    // 复刻 2026-09-23 智谱 web-reader 实抓：无链接结构，页首头像为 sns-avatar（应跳过）
    const zhipuMd = [
      "![Image 1](https://sns-avatar-qc.xhscdn.com/avatar/head.webp)",
      "",
      "![Image 2](https://sns-avatar-qc.xhscdn.com/avatar/head.webp)",
      "",
      "栗子Li🌰",
      "",
      "小红书号：839158372 IP属地：浙江",
      "",
      "🔍 INFJ职场妈妈 ｜养了一颗板栗🌰",
      "",
      "29岁",
      "",
      "10+关注",
      "",
      "10+粉丝",
      "",
      "1千+获赞与收藏",
      "",
      "笔记",
      "",
      "收藏",
      "",
      "![Image 3](https://sns-webpic-qc.xhscdn.com/202609230913/ce5c/cover1.webp)",
      "",
      "用王家卫美学把宝宝洗澡拍出电影感🛁",
      "",
      "![Image 4](https://sns-avatar-qc.xhscdn.com/avatar/head.webp)",
      "",
      "栗子Li🌰",
      "",
      "36",
      "",
      "![Image 5](https://sns-webpic-qc.xhscdn.com/202609230913/22ca/cover2.webp)",
      "",
      "人生不必如满月🌕",
      "",
      "![Image 6](https://sns-avatar-qc.xhscdn.com/avatar/head.webp)",
      "",
      "栗子Li🌰",
      "",
      "62",
    ].join("\n");
    const p = parseProfileFromRender(zhipuMd, { ogTitle: "栗子Li🌰 - 小红书" });
    expect(p.nickname).toBe("栗子Li🌰");
    expect(p.desc).toBe("🔍 INFJ职场妈妈 ｜养了一颗板栗🌰");
    expect(p.notes).toEqual([
      { title: "用王家卫美学把宝宝洗澡拍出电影感🛁", likes: "36" },
      { title: "人生不必如满月🌕", likes: "62" },
    ]);
  });

  it("两种格式并存时优先链接式（Firecrawl）结果", () => {
    const mixed = FIXTURE_MD + "\n![Image 9](https://sns-webpic-qc.xhscdn.com/cover9.webp)\n\n纯文本式标题\n";
    const p = parseProfileFromRender(mixed, FIXTURE_META);
    expect(p.notes).toHaveLength(2); // 链接式的 2 条，未混入纯文本式
  });
});

describe("fetchBloggerProfile", () => {
  beforeEach(() => {
    vi.mocked(fetchViaReader).mockReset();
  });

  it("带 xsec_token 的链接：经云端渲染返回笔记列表", async () => {
    vi.mocked(fetchViaReader).mockResolvedValue({ md: FIXTURE_MD, meta: FIXTURE_META });
    const p = await fetchBloggerProfile(
      "https://www.xiaohongshu.com/user/profile/6992fe8e0000000021012610?xsec_token=ABGMBbU9zALC&xsec_source=pc_user"
    );
    expect(p.nickname).toBe("一口柚柚冰");
    expect(p.notes).toHaveLength(2);
    expect(vi.mocked(fetchViaReader)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchViaReader).mock.calls[0][0]).toContain("xsec_token=");
  });

  it("xhslink 短链：透传给云端渲染（token 由短链 302 携带）", async () => {
    vi.mocked(fetchViaReader).mockResolvedValue({ md: FIXTURE_MD, meta: FIXTURE_META });
    await fetchBloggerProfile("http://xhslink.com/a/AbCdEfG");
    expect(vi.mocked(fetchViaReader)).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  it("裸主页链接（无 xsec_token）直接拒绝并给分享指引，不发起渲染", async () => {
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/5e38c7000000000001006bde")
    ).rejects.toThrow("缺少分享凭证");
    expect(vi.mocked(fetchViaReader)).not.toHaveBeenCalled();
  });

  it("非小红书主页 URL 直接抛错（不发请求）", async () => {
    await expect(fetchBloggerProfile("https://www.bilibili.com/space/1")).rejects.toThrow(
      "暂只支持小红书主页链接"
    );
    expect(vi.mocked(fetchViaReader)).not.toHaveBeenCalled();
  });

  it("云端渲染全通道失败时包装为主页抓取失败 + 分享指引", async () => {
    vi.mocked(fetchViaReader).mockRejectedValue(new Error("Firecrawl API：HTTP 500；智谱 web-reader：未配置"));
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/abc?xsec_token=t")
    ).rejects.toThrow(/主页抓取失败.*分享/);
  });

  it("渲染返回但无笔记数据时抛兜底错误", async () => {
    vi.mocked(fetchViaReader).mockResolvedValue({ md: "TA 还没有发布任何内容哦", meta: {} });
    await expect(
      fetchBloggerProfile("https://www.xiaohongshu.com/user/profile/abc?xsec_token=t")
    ).rejects.toThrow("页面无笔记数据");
  });
});
