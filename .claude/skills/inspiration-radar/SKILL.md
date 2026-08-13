---
name: inspiration-radar
description: 灵感雷达 - 多平台关键词抓取生成创作灵感卡片。给定关键词，用 curl 直连 5 个免登录态数据源（B站搜索 API、必应全网聚合、搜狗微信公众号文章、HackerNews Algolia API、抖音热搜榜），从结果里筛选 top 6 条最有创作价值的内容，整理成结构化 inspirations.md（含平台/作者/标题/摘要/原链接 url/推荐理由/热度指标/候选选题），供自媒体工作台「今日灵感」模块渲染。全部免 cookie、免登录态，curl 直连。当调用方在 prompt 里给出关键词和输出目录（workDir）时使用本 skill。
---

# 灵感雷达 Skill

给定**关键词**，从 5 个免登录态数据源抓取相关内容，整理成结构化灵感卡片，写入 `<workDir>/inspirations.md`。

> **全部免登录态、免 cookie**，只用 curl 直连。**直接用下面命令，不要探索其他工具，不要尝试需要登录的平台（推特/小红书/微博/知乎等）。**

## 输入（来自调用 prompt）
- **关键词**：抓取主题
- **输出目录**：`<workDir>`，产物 `<workDir>/inspirations.md`

## 数据源与确切命令

先准备（每次任务开头跑一次）：
```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
KW="<关键词>"
KW_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$KW")
```

### 源 1：B站（关键词搜索，JSON，中文视频）
```bash
curl -s -c /tmp/bili_ck_$$.txt -o /dev/null -A "$UA" "https://www.bilibili.com/"
curl -s -b /tmp/bili_ck_$$.txt -A "$UA" -e "https://www.bilibili.com/" \
  "https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${KW_ENC}&page=1&page_size=15"
```
- 取 `data.result[]`：`title`(剥离`<em>`)、`author`、`play`、`pubdate`、`bvid`
- **url**：`https://www.bilibili.com/video/<bvid>`

### 源 2：必应全网（关键词搜索，HTML 解析，聚合全网含知乎/CSDN/博客）
```bash
curl -s -A "$UA" "https://cn.bing.com/search?q=${KW_ENC}&count=15"
```
- HTML 里提取 `<li class="b_algo">` 下的 `<h2><a href="真实URL">标题</a>` 和摘要 `<p>`
- **url**：a 标签的 href（真实 URL，如 `https://zhuanlan.zhihu.com/...`、`https://blog.csdn.net/...`）

### 源 3：搜狗微信（关键词搜公众号文章，HTML 解析，中文深度）
```bash
curl -s -A "$UA" "https://weixin.sogou.com/weixin?type=2&query=${KW_ENC}&ie=utf8"
```
- HTML 里每条结果的标题（`<h3>` 或 `class="tit"` 下的 `<a>` 文本）+ 摘要
- **url**：优先提取真实 `mp.weixin.qq.com/s/...` 链接；提取不到则用搜狗中转链接

### 源 4：HackerNews（关键词搜索，JSON，海外 AI/科技一手）
```bash
curl -s "https://hn.algolia.com/api/v1/search?query=${KW_ENC}&tags=story&hitsPerPage=10"
```
- 取 `hits[]`：`title`、`author`、`points`、`num_comments`、`created_at`、`url`、`objectID`
- **url**：`hits[].url`（外链）；若无则 `https://news.ycombinator.com/item?id=<objectID>`

### 源 5：抖音热搜榜（非关键词，是当下大众热点，JSON，补充维度）
```bash
curl -s -A "$UA" "https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/"
```
- 取 `word_list[]`：`word`、`hot_value`
- **url**：`https://www.douyin.com/search/<URL编码word>`（搜索页，无原生链接）
- **pf=bili→抖音热搜用 douyin**

> **效率优先**：5 个源**无需全抓**。任一组合抓到 **≥6 条优质**就停止、进入筛选。某源失败/超时/被墙，**最多重试 1 次**，仍失败就跳过——**绝不反复重试**。

## 筛选 top 6
从抓到的结果里挑最多 6 条最有创作价值的：与关键词相关度高、有讨论度、有延展性（能写成观点/方法/评测）。优先与关键词精准匹配的（B站/必应/搜狗微信/HN），抖音热搜作为"意外热点"补充。

## 写 inspirations.md（严格格式）

每条 `## N` 分隔，字段 `- key: value`，**半角分隔符**（`,` 和 `|`）。每条**必须含 url**：

```markdown
## 1
- pf: bing
- pfn: 全网
- author: 腾讯云开发者社区
- pub: 2 周前
- t: 标题文本
- s: 1-2 句摘要。
- url: https://真实链接
- why: 与关键词直接相关 | 数据详实可引用 | 角度有延展性
- m: 热度,82,coral | 匹配,90,matcha | 可写性,85,honey
- cands: method,选题1 | eval,选题2 | op,选题3
```

字段说明：
- `pf`：`bili`/`bing`/`weixin`/`hn`/`douyin`（**只允许这 5 个**）
- `pfn`：`B站`/`全网`/`微信`/`HackerNews`/`抖音`
- `url`：**必填**，原内容可点击链接（抖音热搜用搜索页 URL）
- `author`/`pub`：作者 + 相对时间（HN 用 created_at，B站用 pubdate，无则填"未知"/"最近"）
- `t`：**必填**，纯文本标题
- `s`：1-2 句摘要
- `why`：3 条推荐理由，` | ` 分隔
- `m`：3 个指标（热度/匹配/可写性），`名字,0-100整数,颜色key`（coral/lav/matcha/honey）
- `cands`：3 个候选选题，`类型,选题`，类型 method/eval/op/tutorial

## 容错
- 抓到 < 6 条：整理几条就几条（0~6 均可）
- 全部失败：写空 inspirations.md（无 `## N` 条目）
- `t` 或 `url` 缺失的条目：跳过不写
- 绝不因单源失败中断整个任务

## 产物
唯一必需文件：`<workDir>/inspirations.md`。不留中间产物。
