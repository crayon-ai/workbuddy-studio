/**
 * 爆款拆解报告 md → 自包含 HTML 文档。
 *
 * 零依赖（不引入 marked/markdown-it），内联 CSS、可双击打开、可打印成 PDF。
 * 覆盖拆解报告实际用到的 markdown 子集：frontmatter、## / ### 标题、粗体、
 * 行内码、代码块、引用、有序/无序列表、表格、分隔线。
 */

export interface ReportHtmlMeta {
  title: string;
  author?: string;
  date?: string;
  likes?: string;
  favs?: string;
  comments?: string;
  reportDate?: string;
  /** md 源文件名（页脚标注用） */
  mdFile?: string;
}

const ACC = ["coral", "lav", "honey", "rose", "matcha"] as const;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(t: string): string {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return s;
}

export interface MdRender {
  html: string;
  toc: { id: string; text: string }[];
}

/** markdown 正文（frontmatter 会剥掉）→ HTML 片段 + h2 目录。 */
export function mdToHtml(md: string): MdRender {
  const src = md.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const lines = src.split("\n");
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let i = 0;
  let h2n = 0;

  while (i < lines.length) {
    const L = lines[i];

    // 代码块
    if (/^```/.test(L)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
      i++;
      continue;
    }

    // 标题
    const h = L.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const txt = h[2].trim();
      if (lv === 2) {
        h2n++;
        const id = "sec-" + h2n;
        const acc = ACC[(h2n - 1) % ACC.length];
        // 标题里常带「一、」序号，与编号芯片重复，展示时剥掉
        const clean = txt.replace(/^[一二三四五六七八九十]+、\s*/, "");
        out.push(
          `<h2 id="${id}"><span class="no" style="--acc:var(--${acc})">${String(h2n).padStart(2, "0")}</span>${inline(clean)}</h2>`
        );
        toc.push({ id, text: clean.replace(/[？?！!。]/g, "") });
      } else if (lv === 3) {
        out.push("<h3>" + inline(txt) + "</h3>");
      } else {
        out.push('<h2 style="font-size:22px">' + inline(txt) + "</h2>");
      }
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})\s*$/.test(L)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(L)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push("<blockquote>" + buf.map((b) => (b.trim() ? "<p>" + inline(b) + "</p>" : "")).join("") + "</blockquote>");
      continue;
    }

    // 表格
    if (/^\|.*\|\s*$/.test(L)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].trim());
      const cells = (r: string) => r.slice(1, -1).split("|").map((c) => c.trim());
      if (
        rows.length >= 2 &&
        /^[\s|:-]+$/.test(rows[1].replace(/[^|:\-\s]/g, ""))
      ) {
        const head = cells(rows[0]);
        let t = "<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
        for (let r = 2; r < rows.length; r++) {
          t += "<tr>" + cells(rows[r]).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
        }
        out.push(t + "</tbody></table>");
      } else {
        rows.forEach((r) => out.push("<p>" + inline(r) + "</p>"));
      }
      continue;
    }

    // 无序 / 有序列表
    if (/^\s*[-*]\s+/.test(L)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push("<ul>" + buf.map((b) => "<li>" + inline(b) + "</li>").join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+[.、]\s+/.test(L)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+[.、]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.、]\s+/, ""));
      out.push("<ol>" + buf.map((b) => "<li>" + inline(b) + "</li>").join("") + "</ol>");
      continue;
    }

    // 空行
    if (!L.trim()) {
      i++;
      continue;
    }

    // 段落
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3}\s|>|```|\||\s*[-*]\s|\s*\d+[.、]\s)/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push("<p>" + inline(buf.join("<br>")) + "</p>");
  }

  return { html: out.join("\n"), toc };
}

/** md 报告 + 元数据 → 完整自包含 HTML 文档（与 md 同目录的 .html 产物）。 */
export function mdToReportHtml(md: string, meta: ReportHtmlMeta): string {
  const { html, toc } = mdToHtml(md);
  const chips = toc
    .map((t, idx) => `<a href="#sec-${idx + 1}">${idx + 1} · ${esc(t.text)}</a>`)
    .join("");
  const genDate = meta.reportDate || new Date().toISOString().slice(0, 10);
  const m = (label: string, v?: string) =>
    v ? `<div>${label}<b>${esc(v)}</b></div>` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(meta.title)} · 爆款拆解报告</title>
<style>
:root{--cream:#FAF4EA;--cream-2:#F4E9D7;--paper:#FFFDF8;--ink:#3A322C;--ink-2:#6E635A;--ink-3:#A89E92;--line:#ECE0CD;--line-2:#E2D2B8;--coral-d:#D86A3A;--coral-bg:#FCE6D6;--lav-d:#8474BE;--lav-bg:#EEEBF7;--sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,system-ui,sans-serif;--serif:"Songti SC","Source Han Serif SC","Noto Serif SC",Georgia,serif}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--cream);color:var(--ink);line-height:1.8;-webkit-font-smoothing:antialiased}
.chips{position:sticky;top:0;z-index:9;display:flex;gap:6px;overflow-x:auto;background:rgba(250,244,234,.92);backdrop-filter:blur(8px);padding:10px 18px;border-bottom:1px solid var(--line);scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chips a{flex-shrink:0;font-size:11.5px;font-weight:600;text-decoration:none;color:var(--lav-d);background:var(--lav-bg);padding:4px 12px;border-radius:999px}
.chips a:hover{background:#A99CD6;color:#fff}
.sheet{max-width:840px;margin:30px auto 64px;background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 2px 6px rgba(122,90,50,.05),0 14px 34px rgba(122,90,50,.09);padding:clamp(26px,5vw,54px)}
.eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--lav-d);background:var(--lav-bg);padding:4px 12px;border-radius:999px;letter-spacing:.04em}
h1{font-family:var(--serif);font-size:clamp(21px,3.4vw,27px);line-height:1.45;letter-spacing:-.01em;margin:14px 0 18px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;background:var(--cream);border:1px solid var(--line);border-radius:13px;padding:14px 16px;margin:18px 0 8px}
.meta div{font-size:11px;color:var(--ink-3);font-weight:600}
.meta b{display:block;font-size:13px;color:var(--ink);font-weight:700;margin-top:2px}
article h2{font-family:var(--serif);font-size:19px;margin:40px 0 14px;padding-bottom:10px;border-bottom:1px dashed var(--line-2);display:flex;align-items:center;gap:10px;scroll-margin-top:64px}
article h2 .no{flex-shrink:0;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:800;font-family:var(--sans);color:#fff;background:var(--acc,var(--lav))}
article h3{font-size:14.5px;margin:22px 0 10px}
article p{font-size:13.5px;line-height:1.9;margin:10px 0}
article ul,article ol{padding-left:22px;margin:10px 0}
article li{font-size:13.5px;line-height:1.85;margin:5px 0}
article blockquote{background:var(--cream);border-radius:13px;padding:13px 18px;font-size:13px;color:var(--ink-2);margin:14px 0}
article blockquote p{margin:4px 0;color:var(--ink-2)}
article pre{background:var(--cream-2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow-x:auto;margin:12px 0;font-size:12px;line-height:1.7;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
article :not(pre)>code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--coral-bg);color:var(--coral-d);padding:1px 6px;border-radius:5px}
article table{width:100%;border-collapse:collapse;margin:14px 0;font-size:12.5px;border:1px solid var(--line)}
article th{background:var(--lav-bg);color:var(--lav-d);font-weight:700;text-align:left;font-size:12px}
article th,article td{padding:9px 12px;border:1px solid var(--line);vertical-align:top;line-height:1.7}
article td{color:var(--ink-2)}
article td:first-child{color:var(--ink);font-weight:600}
article hr{border:none;border-top:1px dashed var(--line-2);margin:28px 0}
.foot{margin-top:44px;padding-top:16px;border-top:1px dashed var(--line-2);text-align:center;font-size:11.5px;color:var(--ink-3);line-height:1.9}
@media print{body{background:#fff}.chips{display:none}.sheet{box-shadow:none;border:none;max-width:100%;margin:0;padding:0;border-radius:0}}
</style>
</head>
<body>
<nav class="chips" aria-label="目录">${chips}</nav>
<div class="sheet">
<span class="eyebrow">⚡ 爆款拆解报告 · WorkBuddy</span>
<h1>${esc(meta.title)}</h1>
<div class="meta">${m("作者", meta.author)}${m("平台", "小红书")}${m("互动", [meta.likes && `赞 ${meta.likes}`, meta.favs && `藏 ${meta.favs}`, meta.comments && `评 ${meta.comments}`].filter(Boolean).join(" · ") || undefined)}${m("发布 / 拆解", [meta.date, meta.reportDate].filter(Boolean).join(" / ") || undefined)}</div>
<article>${html}</article>
<div class="foot">由 WorkBuddy · 爆款拆解生成于 ${esc(genDate)}<br>Markdown 源文件：${esc(meta.mdFile || meta.title + ".md")}（与本文同目录）</div>
</div>
</body>
</html>`;
}
