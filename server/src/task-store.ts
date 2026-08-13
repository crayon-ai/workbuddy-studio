export type Status = "pending" | "running" | "done" | "failed";

export interface Task {
  id: string;
  status: Status;
  result?: unknown;
  error?: string;
  createdAt: number;
  /** 当前步骤描述（供前端展示进度） */
  step?: string;
  /** 当前工具调用细节 */
  detail?: string;
  /** 累积的步骤日志（最近 N 条） */
  logs?: string[];
  updatedAt?: number;
}

/** 内存任务表（重启丢失，前端可重提）。 */
const tasks = new Map<string, Task>();

export function createTask(): string {
  const id = crypto.randomUUID();
  tasks.set(id, { id, status: "pending", createdAt: Date.now() });
  return id;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): void {
  const t = tasks.get(id);
  if (t) tasks.set(id, { ...t, ...patch });
}
