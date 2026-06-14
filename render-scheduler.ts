export interface RenderScheduler {
  schedule(delayMs?: number): void;
  cancel(): void;
}

export function createRenderScheduler(render: () => void, defaultDelayMs: number): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingDelayMs: number | null = null;

  return {
    schedule(delayMs = defaultDelayMs) {
      if (timer) {
        if (pendingDelayMs !== null && delayMs >= pendingDelayMs) return;
        clearTimeout(timer);
        timer = null;
        pendingDelayMs = null;
      }

      pendingDelayMs = delayMs;
      timer = setTimeout(() => {
        timer = null;
        pendingDelayMs = null;
        render();
      }, delayMs);
    },
    cancel() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      pendingDelayMs = null;
    },
  };
}
