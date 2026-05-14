export interface SessionTaskSummary {
  active: boolean;
  queuedCount: number;
  sessionKey: string;
}

export interface TaskSchedulerSnapshot {
  activeCount: number;
  maxParallel: number;
  queuedCount: number;
  sessions: SessionTaskSummary[];
}

interface QueuedTask {
  id: number;
  label?: string;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<unknown>;
  sessionKey: string;
}

interface SessionQueue {
  active?: QueuedTask;
  queue: QueuedTask[];
}

export class SessionTaskScheduler {
  private activeCount = 0;
  private nextTaskId = 1;
  private readonly sessions = new Map<string, SessionQueue>();
  readonly maxParallel: number;

  constructor(maxParallel: number) {
    this.maxParallel = Math.max(1, Math.floor(maxParallel));
  }

  schedule<T>(
    sessionKey: string,
    run: () => Promise<T>,
    options: { label?: string } = {}
  ): Promise<T> {
    const cleanSessionKey = sessionKey.trim() || "default";
    const session = this.getOrCreateSession(cleanSessionKey);

    const promise = new Promise<T>((resolve, reject) => {
      session.queue.push({
        id: this.nextTaskId++,
        label: options.label,
        reject,
        resolve: (value) => resolve(value as T),
        run: async () => await run(),
        sessionKey: cleanSessionKey
      });
    });

    this.pump();
    return promise;
  }

  snapshot(): TaskSchedulerSnapshot {
    const sessions: SessionTaskSummary[] = [];
    let queuedCount = 0;

    for (const [sessionKey, session] of this.sessions) {
      queuedCount += session.queue.length;
      sessions.push({
        active: Boolean(session.active),
        queuedCount: session.queue.length,
        sessionKey
      });
    }

    return {
      activeCount: this.activeCount,
      maxParallel: this.maxParallel,
      queuedCount,
      sessions
    };
  }

  private getOrCreateSession(sessionKey: string): SessionQueue {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const created: SessionQueue = { queue: [] };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private pump(): void {
    if (this.activeCount >= this.maxParallel) {
      return;
    }

    for (const [sessionKey, session] of this.sessions) {
      if (this.activeCount >= this.maxParallel) {
        return;
      }

      if (session.active || session.queue.length === 0) {
        continue;
      }

      const task = session.queue.shift();
      if (!task) {
        continue;
      }

      this.startTask(sessionKey, session, task);
    }
  }

  private startTask(sessionKey: string, session: SessionQueue, task: QueuedTask): void {
    session.active = task;
    this.activeCount += 1;

    void Promise.resolve()
      .then(() => task.run())
      .then(task.resolve, task.reject)
      .finally(() => {
        session.active = undefined;
        this.activeCount -= 1;

        if (session.queue.length === 0) {
          this.sessions.delete(sessionKey);
        }

        this.pump();
      });
  }
}
