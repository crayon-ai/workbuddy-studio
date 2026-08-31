import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveModelName } from "./config.js";

export interface RunSkillResult {
  ok: boolean;
  text: string;
  artifacts: Record<string, string>;
  error?: string;
}

export interface RunSkillOpts {
  apiKey: string;
  /** 项目根（含 .claude/skills/），作为 agent session 的 cwd */
  projectRoot: string;
}

/**
 * 按当前厂商返回子进程要用的模型名（含 DeepSeek）：
 * - zhipu → glm-4.6
 * - deepseek → deepseek-v4-pro（不传会被 DeepSeek 静默降级成弱模型）
 * - 其他 → undefined，走 SDK 默认
 */
function modelForProvider(): string | undefined {
  return resolveModelName();
}

export interface SkillProgress {
  /** 当前步骤描述（来自 assistant 的文字） */
  step?: string;
  /** 当前工具调用细节（如 Bash 命令、Read 文件） */
  detail?: string;
}

/**
 * 调用一个项目自带 skill，返回 agent 最终文本 + workDir 下的 .md 产物。
 * onProgress 在 agent 输出文字或调用工具时回调，用于上报进度。
 */
export async function runSkill(
  skillName: string,
  prompt: string,
  workDir: string,
  opts: RunSkillOpts,
  onProgress?: (p: SkillProgress) => void
): Promise<RunSkillResult> {
  mkdirSync(workDir, { recursive: true });
  if (opts.apiKey) process.env.ANTHROPIC_AUTH_TOKEN = opts.apiKey;

  const fullPrompt = `请使用 ${skillName} skill 完成以下任务。\n\n${prompt}`;
  let text = "";
  let agentError = ""; // agent 非正常结束的原因（error_max_turns / error_during_execution 等）

  try {
    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        settingSources: ["project"],
        allowedTools: ["Read", "Write", "Edit", "Bash"],
        cwd: opts.projectRoot,
        ...(modelForProvider() ? { model: modelForProvider() } : {}),
      },
    })) {
      const m = msg as {
        type: string;
        subtype?: string;
        result?: string;
        message?: { content?: Array<{ type: string; text?: string; name?: string; input?: any }> };
      };

      if (m.type === "assistant" && m.message?.content && onProgress) {
        for (const block of m.message.content) {
          if (block.type === "text" && block.text) {
            onProgress({ step: truncate(block.text, 200) });
          } else if (block.type === "tool_use") {
            onProgress({ detail: toolSummary(block) });
          }
        }
      }

      if (m.type === "result") {
        if (m.subtype === "success") {
          text = m.result ?? "";
        } else {
          // 非正常结束不当作成功：否则 ok=true + 空产物，真实原因被吞掉
          agentError = `agent 异常结束（subtype=${m.subtype}）：${truncate(m.result ?? "无详情", 300)}`;
        }
      }
    }
  } catch (e: any) {
    const detail = serializeError(e);
    console.error(`[skill:${skillName}] 调用异常：${detail}`);
    return { ok: false, text: "", artifacts: {}, error: detail };
  }

  if (agentError) {
    console.error(`[skill:${skillName}] ${agentError}`);
    return { ok: false, text: "", artifacts: {}, error: agentError };
  }

  return { ok: true, text, artifacts: collectMarkdown(workDir) };
}

/**
 * 把异常序列化成尽量完整的一行多行文本：message + 关键字段（stderr/exitCode 等）+ 堆栈前几行。
 * SDK 抛的错误常带 stderr / exit_code 等字段，只取 message 会丢最关键的排查信息。
 */
function serializeError(e: any): string {
  const parts: string[] = [e?.message ?? String(e)];
  for (const key of ["stderr", "stdout", "exitCode", "exit_code", "code"]) {
    const v = e?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      parts.push(`${key}=${truncate(String(v), 400)}`);
    }
  }
  if (e?.stack) parts.push(truncate(e.stack, 600));
  return parts.join(" | ");
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

function toolSummary(block: { name?: string; input?: any }): string {
  const name = block.name ?? "tool";
  const input = block.input || {};
  if (name === "Bash" && input.command) {
    return "命令: " + truncate(String(input.command), 90);
  }
  if (name === "Read") return "读取: " + (input.file_path || "");
  if (name === "Write") return "写入: " + (input.file_path || "");
  if (name === "Edit") return "编辑: " + (input.file_path || "");
  return name;
}

/** 递归收集 dir 下所有 .md 文件，返回 { 文件名: 内容 }。 */
export function collectMarkdown(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md")) out[name] = readFileSync(p, "utf8");
    }
  };
  try { walk(dir); } catch { /* dir 不存在或不可读 */ }
  return out;
}
