import { describe, expect, test } from "bun:test";
import {
  BridgeLifecycle,
  type BridgeLifecycleOperations,
} from "../../src/bridge/lifecycle";

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  return {
    promise: new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  };
}

function operations(
  overrides: Partial<BridgeLifecycleOperations> = {},
): BridgeLifecycleOperations {
  return {
    beginShutdown: () => undefined,
    registerCommands: async () => undefined,
    startPolling: async (onReady) => onReady(),
    stopPolling: async () => undefined,
    closeIngress: (stopPolling) => stopPolling(),
    closeAgents: async () => undefined,
    closeOutbound: async () => undefined,
    closeDrafts: async () => undefined,
    closeActivity: async () => undefined,
    ...overrides,
  };
}

describe("BridgeLifecycle", () => {
  test("命令注册期间开始关闭时不会再启动轮询", async () => {
    const registration = deferred();
    let pollingStarts = 0;
    const lifecycle = new BridgeLifecycle(
      operations({
        registerCommands: () => registration.promise,
        startPolling: async () => {
          pollingStarts += 1;
        },
      }),
    );

    const starting = lifecycle.start();
    const stopping = lifecycle.stop();
    registration.resolve();

    await Promise.all([starting, stopping]);
    expect(pollingStarts).toBe(0);
  });

  test("关闭按 update、关键发送、子进程和活动资源顺序执行", async () => {
    const polling = deferred();
    const ingress = deferred();
    const agents = deferred();
    const outbound = deferred();
    const calls: string[] = [];
    const lifecycle = new BridgeLifecycle(
      operations({
        startPolling: (onReady) => {
          onReady();
          return polling.promise;
        },
        stopPolling: async () => {
          calls.push("polling");
        },
        closeIngress: async (stopPolling) => {
          calls.push("ingress");
          await ingress.promise;
          await stopPolling();
        },
        closeAgents: async () => {
          calls.push("agents");
          await agents.promise;
        },
        closeOutbound: async () => {
          calls.push("outbound");
          await outbound.promise;
        },
        closeDrafts: async () => {
          calls.push("drafts");
        },
        closeActivity: async () => {
          calls.push("activity");
        },
      }),
    );

    const starting = lifecycle.start();
    await Promise.resolve();
    const stopping = lifecycle.stop();
    await Promise.resolve();
    expect(calls).toEqual(["ingress"]);

    ingress.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["ingress", "polling"]);

    polling.resolve();
    await starting;
    await Bun.sleep(0);
    expect(calls).toEqual(["ingress", "polling", "agents"]);

    agents.resolve();
    await Bun.sleep(0);
    expect(calls).toEqual(["ingress", "polling", "agents", "outbound"]);

    outbound.resolve();
    await stopping;
    expect(calls).toEqual([
      "ingress",
      "polling",
      "agents",
      "outbound",
      "drafts",
      "activity",
    ]);
  });

  test("轮询在关闭期间失败时关闭也返回失败", async () => {
    const polling = deferred();
    const lifecycle = new BridgeLifecycle(
      operations({
        startPolling: (onReady) => {
          onReady();
          return polling.promise;
        },
        closeIngress: async () => undefined,
      }),
    );

    const starting = lifecycle.start();
    void starting.catch(() => undefined);
    await Promise.resolve();
    const stopping = lifecycle.stop();
    void stopping.catch(() => undefined);
    polling.reject(new Error("polling failed"));

    await expect(starting).rejects.toThrow("polling failed");
    await expect(stopping).rejects.toThrow("服务关闭不完整");
  });

  test("轮询初始化期间关闭会等待就绪后正常停止", async () => {
    const initialization = deferred();
    const polling = deferred();
    let stopCalls = 0;
    const lifecycle = new BridgeLifecycle(
      operations({
        startPolling: async (onReady) => {
          await initialization.promise;
          onReady();
          await polling.promise;
        },
        stopPolling: async () => {
          stopCalls += 1;
          polling.resolve();
        },
      }),
    );

    const starting = lifecycle.start();
    await Promise.resolve();
    const stopping = lifecycle.stop();
    await Promise.resolve();
    expect(stopCalls).toBe(0);

    initialization.resolve();
    await Promise.all([starting, stopping]);
    expect(stopCalls).toBe(1);
  });

  test("重复关闭共享同一个任务并继续执行失败后的清理", async () => {
    const calls: string[] = [];
    const lifecycle = new BridgeLifecycle(
      operations({
        stopPolling: async () => {
          calls.push("polling");
          throw new Error("polling failed");
        },
        closeAgents: async () => {
          calls.push("agents");
        },
        closeDrafts: async () => {
          calls.push("drafts");
        },
        closeActivity: async () => {
          calls.push("activity");
        },
      }),
    );

    await lifecycle.start();
    const first = lifecycle.stop();
    const second = lifecycle.stop();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow("服务关闭不完整");
    expect(calls).toEqual(["polling", "agents", "drafts", "activity"]);
  });
});
