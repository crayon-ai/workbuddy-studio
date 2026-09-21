import { describe, expect, it } from "vitest";
import { parseReaderPayload } from "./reader-fetch.js";

/** fixture 复刻 2026-09-21 实抓的小红书视频帖 Firecrawl 返回（markdown 摘录 + og 元数据）。 */
const FIXTURE_MD = [
  "[![](<Base64-Image-Removed>)](https://www.xiaohongshu.com/explore?channel_type=web_note_detail_r10)",
  "",
  "创作中心",
  "",
  "[HiHi小壮](https://www.xiaohongshu.com/user/profile/697f16e7000000002102098f?channel_type=web_note_detail_r10&xsec_token=ABaYeB6n&xsec_source=pc_user)",
  "",
  "关注",
  "",
  "# 审美培养｜8个设计Skill分享",
  "",
  "一口气分享8个高级审美设计风格skill！",
  "1️⃣高级单色印刷海报",
  "",
  "4天前 北京",
  "",
  "加载中",
].join("\n");

const FIXTURE_META: Record<string, any> = {
  "og:xhs:note_comment": "569",
  title: "审美培养｜8个设计Skill分享 - 小红书",
  description: "一口气分享8个高级审美设计风格skill！",
  ogTitle: "审美培养｜8个设计Skill分享 - 小红书",
  ogVideo: "https://sns-video-zl.xhscdn.com/stream/1/110/258/xxx_258.mp4?sign=a5ed&t=6ab5",
  "og:site_name": "小红书",
  "og:type": "video.other",
  "og:image": [
    "//picasso-static.xiaohongshu.com/fe-platform/f43dc4a8.png",
    "http://sns-webpic-qc.xhscdn.com/20260921/spectrum/1040g34o3253!nd_dft.webp",
    "//sns-avatar-qc.xhscdn.com/avatar/1040g2jo31s2.webp",
  ],
  "og:xhs:note_collect": "2966",
  "og:xhs:note_like": "2718",
  "og:videotime": "01:12",
  "og:video": "https://sns-video-zl.xhscdn.com/stream/1/110/258/xxx_258.mp4?sign=a5ed&t=6ab5",
  "og:description": "一口气分享8个高级审美设计风格skill！ #skill #AI工具",
};

describe("parseReaderPayload（Firecrawl 抓取结果 → ReaderNote）", () => {
  it("解析视频帖：标题去站名后缀、og 互动数据、签名视频直链、时长", () => {
    const note = parseReaderPayload(FIXTURE_MD, FIXTURE_META);
    expect(note).not.toBeNull();
    expect(note!.title).toBe("审美培养｜8个设计Skill分享");
    expect(note!.desc).toContain("一口气分享8个");
    expect(note!.author).toBe("HiHi小壮");
    expect(note!.type).toBe("video");
    expect(note!.like).toBe("2718");
    expect(note!.fav).toBe("2966");
    expect(note!.comment).toBe("569");
    expect(note!.videoUrl).toContain("sns-video-zl.xhscdn.com");
    expect(note!.videoUrl).toContain("sign=");
    expect(note!.videoDurationSec).toBe(72);
  });

  it("图片列表：剔除平台占位图与头像，只留内容图并补全协议", () => {
    const note = parseReaderPayload(FIXTURE_MD, FIXTURE_META);
    expect(note!.imageUrls).toHaveLength(1);
    expect(note!.imageUrls[0]).toMatch(/^https:\/\/sns-webpic-qc\.xhscdn\.com\//);
  });

  it("相对时间「4天前」换算为 timeMs", () => {
    const note = parseReaderPayload(FIXTURE_MD, FIXTURE_META);
    const fourDays = 4 * 864e5;
    expect(note!.timeMs).toBeGreaterThan(Date.now() - fourDays - 36e5);
    expect(note!.timeMs).toBeLessThan(Date.now() - fourDays + 36e5);
  });

  it("图文帖：无 og:video 时 type=normal、不带视频直链", () => {
    const meta: Record<string, any> = {
      "og:title": "零基础教程｜如何0成本制作个人网站 - 小红书",
      "og:description": "正文……",
      "og:type": "article",
      "og:image": "//sns-webpic-qc.xhscdn.com/20260921/spectrum/abc.webp",
    };
    const note = parseReaderPayload("正文", meta);
    expect(note!.type).toBe("normal");
    expect(note!.videoUrl).toBeUndefined();
    expect(note!.imageUrls[0]).toMatch(/^https:\/\//);
  });

  it("标题与正文都拿不到时返回 null（不编造）", () => {
    expect(parseReaderPayload("", { "og:site_name": "小红书" })).toBeNull();
    expect(parseReaderPayload("", {})).toBeNull();
  });
});
