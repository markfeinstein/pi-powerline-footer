interface CoreContextUsage {
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readCoreContextUsage(ctx: unknown): CoreContextUsage | null {
  if (!isRecord(ctx)) {
    return null;
  }

  let getContextUsage: unknown;
  try {
    getContextUsage = ctx.getContextUsage;
  } catch {
    return null;
  }

  if (typeof getContextUsage !== "function") {
    return null;
  }

  let usage: unknown;
  try {
    usage = getContextUsage.call(ctx);
  } catch {
    return null;
  }

  if (!isRecord(usage)) {
    return null;
  }

  let tokens: unknown;
  let contextWindow: unknown;
  let percent: unknown;
  try {
    tokens = usage.tokens;
    contextWindow = usage.contextWindow;
    percent = usage.percent;
  } catch {
    return null;
  }

  if (
    typeof tokens !== "number"
    || !Number.isFinite(tokens)
    || typeof contextWindow !== "number"
    || !Number.isFinite(contextWindow)
    || contextWindow <= 0
  ) {
    return null;
  }
  return {
    contextTokens: tokens,
    contextWindow,
    contextPercent: typeof percent === "number" && Number.isFinite(percent)
      ? percent
      : (tokens / contextWindow) * 100,
  };
}
