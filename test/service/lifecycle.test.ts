import { describe, expect, test } from "bun:test";
import {
  logServiceConfigLoaded,
  logServiceStarted,
  logServiceStartFailed,
  runManagedService,
  ServiceShutdownController,
  stopService,
} from "../../src/service/lifecycle";
import { RecordingLogger } from "../helpers/recording-logger";

describe("service lifecycle logging", () => {
  test("记录启动、停止请求、开始关闭和关闭完成", async () => {
    const logger = new RecordingLogger();
    const times = [100, 125];
    let stopped = false;

    logServiceConfigLoaded(logger, 3, true);
    logServiceStarted(logger, 42);
    const succeeded = await stopService(
      logger,
      "SIGTERM",
      async () => {
        stopped = true;
      },
      () => times.shift() ?? 125,
    );

    expect(succeeded).toBe("stopped");
    expect(stopped).toBeTrue();
    expect(logger.entries).toEqual([
      {
        event: "service_config_loaded",
        fields: { allowed_user_count: 3, stream_responses: true },
      },
      {
        event: "service_started",
        fields: { process_id: 42 },
      },
      {
        event: "service_stop_requested",
        fields: { signal: "SIGTERM" },
      },
      {
        event: "service_stopping",
        fields: { signal: "SIGTERM" },
      },
      {
        event: "service_stopped",
        fields: { duration_ms: 25 },
      },
    ]);
  });

  test("启动失败使用安全 Info 事件", () => {
    const logger = new RecordingLogger();

    logServiceStartFailed(logger, new Error("private startup details"));

    expect(logger.entries).toEqual([
      {
        event: "service_start_failed",
        fields: {
          error_name: "Error",
          reason: "startup_failed",
        },
      },
    ]);
  });

  test("关闭失败使用安全 Info 事件", async () => {
    const logger = new RecordingLogger();

    const succeeded = await stopService(logger, "SIGINT", async () => {
      throw new Error("private shutdown details");
    });

    expect(succeeded).toBe("failed");
    expect(logger.entries.at(-1)).toEqual({
      event: "service_stop_failed",
      fields: {
        error_name: "Error",
        reason: "shutdown_failed",
      },
    });
  });

  test("关闭超过总时限后返回失败且处理晚到 rejection", async () => {
    const logger = new RecordingLogger();
    let rejectStop: ((error: Error) => void) | undefined;
    const stop = new Promise<void>((_resolve, reject) => {
      rejectStop = reject;
    });

    const succeeded = await stopService(
      logger,
      "SIGTERM",
      () => stop,
      Date.now,
      5,
    );
    rejectStop?.(new Error("late failure"));
    await Promise.resolve();

    expect(succeeded).toBe("timed_out");
    expect(logger.entries.at(-1)).toEqual({
      event: "service_stop_failed",
      fields: {
        error_name: "Error",
        reason: "shutdown_timeout",
      },
    });
  });

  test("第一次信号优雅关闭，第二次信号立即强制退出", async () => {
    const logger = new RecordingLogger();
    let stopCalls = 0;
    let releaseStop: (() => void) | undefined;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const exitCodes: number[] = [];
    const forcedExits: number[] = [];
    const shutdown = new ServiceShutdownController({
      logger,
      stop: async () => {
        stopCalls += 1;
        await stopPending;
      },
      setExitCode: (code) => exitCodes.push(code),
      forceExit: (code) => forcedExits.push(code),
      timeoutMs: 100,
    });

    shutdown.request("SIGINT");
    shutdown.request("SIGTERM");
    expect(stopCalls).toBe(1);
    expect(forcedExits).toEqual([143]);

    releaseStop?.();
    await shutdown.wait();
    expect(exitCodes).toEqual([0]);
    expect(logger.events()).toContain("service_stop_forced");
  });

  test("优雅关闭超时后强制退出", async () => {
    const logger = new RecordingLogger();
    const exitCodes: number[] = [];
    const forcedExits: number[] = [];
    const shutdown = new ServiceShutdownController({
      logger,
      stop: () => new Promise<void>(() => undefined),
      setExitCode: (code) => exitCodes.push(code),
      forceExit: (code) => forcedExits.push(code),
      timeoutMs: 5,
    });

    shutdown.request("SIGTERM");
    await shutdown.wait();

    expect(exitCodes).toEqual([]);
    expect(forcedExits).toEqual([1]);
    expect(logger.entries.at(-1)).toEqual({
      event: "service_stop_failed",
      fields: {
        error_name: "Error",
        reason: "shutdown_timeout",
      },
    });
  });

  test("信号关闭会等待运行任务结束后退出", async () => {
    const logger = new RecordingLogger();
    let finishStart: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const exitCodes: number[] = [];
    const forcedExits: number[] = [];
    const service = {
      start: () => running,
      stop: async () => {
        finishStart?.();
      },
    };
    const shutdown = new ServiceShutdownController({
      logger,
      stop: () => service.stop(),
      setExitCode: (code) => exitCodes.push(code),
      forceExit: (code) => forcedExits.push(code),
      timeoutMs: 100,
    });

    const run = runManagedService(
      service,
      logger,
      shutdown,
      (code) => exitCodes.push(code),
      (code) => forcedExits.push(code),
      100,
    );
    shutdown.request("SIGTERM");
    await run;

    expect(exitCodes).toEqual([0]);
    expect(forcedExits).toEqual([]);
    expect(logger.events()).toEqual([
      "service_stop_requested",
      "service_stopping",
      "service_stopped",
    ]);
  });

  test("启动失败会在退出前清理已创建服务", async () => {
    const logger = new RecordingLogger();
    const calls: string[] = [];
    const exitCodes: number[] = [];
    const forcedExits: number[] = [];
    const service = {
      start: async () => {
        calls.push("start");
        throw new Error("startup failed");
      },
      stop: async () => {
        calls.push("stop");
      },
    };
    const shutdown = new ServiceShutdownController({
      logger,
      stop: () => service.stop(),
      setExitCode: (code) => exitCodes.push(code),
      forceExit: (code) => forcedExits.push(code),
    });

    await runManagedService(
      service,
      logger,
      shutdown,
      (code) => exitCodes.push(code),
      (code) => forcedExits.push(code),
      100,
    );

    expect(calls).toEqual(["start", "stop"]);
    expect(exitCodes).toEqual([1]);
    expect(forcedExits).toEqual([]);
    expect(logger.events()).toContain("service_start_failed");
  });
});
