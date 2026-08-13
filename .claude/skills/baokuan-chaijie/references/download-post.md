# 根据链接下载帖子素材 — 命令参考

目标：把一个帖子链接的正文/图片/视频完整下载到
`<目标目录>/<主题>/爆款原文/<帖子标题>/` 独立文件夹。

> `<目标目录>` 完全由用户指定（用户说下到哪就下到哪，不再固定任何前缀）；未指定时先问用户。`<主题>` 为可选二级归类，用户不分主题时可省略这一层。下文命令里的 `$DEST`（即到 `爆款原文/<标题>` 为止的目录）请根据用户指定的实际路径替换。

## 0. 目录结构

```
<目标目录>/<主题>/爆款原文/<帖子标题>/
├── 正文.md
├── 图片/img_01.jpg img_02.jpg ...
└── 视频.mp4   （仅视频帖）
```

下面命令先把目标帖文件夹路径存成变量（把 `<目标目录>/<主题>` 换成用户指定的实际目录）：

```bash
DEST="<目标目录>/<主题>/爆款原文/<标题>"
```

标题里的非法字符 `/ \ : * ? " < > |` 统一替换成下划线 `_`。

## 1. 解析页面拿元数据与媒体直链

优先用 `parse_link` 抓标题、正文、话题标签、图片/视频地址。
拿不到时，请用户提供可访问的原始链接或已导出的素材文件。

## 2. 下载图片（带 Referer，防盗链）

小红书 / 多数平台的图片 CDN 会校验 referer，需带头：

```bash
mkdir -p "$DEST/图片"
i=1
for url in "$IMG1" "$IMG2" "$IMG3"; do
  n=$(printf "%02d" $i)
  curl -sL \
    -H "User-Agent: Mozilla/5.0" \
    -H "Referer: https://www.xiaohongshu.com/" \
    "$url" -o "$DEST/图片/img_${n}.jpg"
  i=$((i+1))
done
```

图片实际后缀按 Content-Type 判断（jpg/png/webp）。

## 3. 下载视频（mp4）

```bash
curl -sL \
  -H "User-Agent: Mozilla/5.0" \
  -H "Referer: https://www.xiaohongshu.com/" \
  "$VIDEO_URL" -o "$DEST/视频.mp4"
```

若视频为 m3u8 分片流，用 ffmpeg（在用户环境，`user_exec`）：

```bash
ffmpeg -i "$M3U8_URL" -c copy "$DEST/视频.mp4"
```

## 3.5 抓取评论区（若有）

评论区常藏着作者补充的金句、被追问的需求、置顶引导，是拆解的重要素材，务必尝试抓取。

### 小红书

评论**不在首屏 HTML** 里（`noteDetailMap[*].comments.list` 初始为空），由
`https://edith.xiaohongshu.com/api/sns/web/v2/comment/page` 异步加载，且带 `x-s / x-t` 签名风控。
**无登录态直接请求会返回 `{"code":-1}` 406**，沙箱一般抓不到。按下面顺序尝试：

1. **先试匿名 API**（偶尔可拿到首屏几条）：
   ```
   GET https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=<id>&cursor=&xsec_token=<token>&image_formats=jpg,webp,avif
   Headers: Referer=<原帖url>, User-Agent=浏览器UA
   ```
   拿到 JSON 后取 `data.comments[]`，字段：`user_info.nickname`、`content`、`like_count`、`sub_comments[]`（作者回复）。
2. **降级方案（推荐兜底）**：请用户在浏览器登录态下**手动复制评论区文本**，或**对评论区截图**丢给我 → 截图走 `analyze_image` 提取。
3. **绝不静默跳过**：若最终没拿到评论，明确告诉用户「评论区未能抓取，需手动补充」。

### 公众号 / 其他平台

- 公众号「精选留言」在文章页可见时，`parse_link` 常能带出；带不出则请用户复制或截图。
- B站/抖音等同理：优先公开 API/页面解析，拿不到就走截图 `analyze_image`。

### 评论.md 模板

```markdown
# <帖子标题> — 评论区

> 原链接：<url>  ｜ 抓取时间：<date>  ｜ 共 N 条（如可得）

- **用户A**（赞 128）：这条评论内容……
  - ↳ 作者回复：谢谢，这个点确实……
- **用户B**（赞 45）：另一条评论……
- **用户C**：普通评论……
```

> 置顶/高赞/作者回复优先，尽量按点赞数从高到低。

## 4. 生成正文.md 模板

```markdown
# <帖子标题>

- 平台：小红书 / 公众号 / ...
- 作者：<作者名>
- 原链接：<url>
- 发布时间：<如可得>
- 互动数据：赞 x / 收藏 y / 评论 z（如可得）
- 话题标签：#xxx #yyy

---

<完整正文文字>
```

## 5. 校对

- 图片数量 == 轮播卡片数量
- 视频能正常播放（`ffprobe` 查时长）
- 评论区已抓取或已明确标注「需手动补充」
- 缺失项明确告诉用户，不静默跳过

## 说明

`curl/wget/ffmpeg` 下载媒体这类联网操作若沙箱不可用，改在用户环境用 `user_exec` 执行（需用户批准）。仅供个人学习研究，尊重版权。
