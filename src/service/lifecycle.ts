import { errorName, type InfoLogger } from "../logging/logger";

export type StopSignal = "SIGINT" | "SIGTERM";
export type StopServiceResult = "stopped" | "failed" | "timed_out";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface ManagedService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServiceShutdownOptions {
  logger: InfoLogger;
  stop(): Promise<void>;
  setExitCode(code: number): void;
  forceExit(code: number): void;
  timeoutMs?: number;
}

export class ServiceShutdownController {
  readonly #options: ServiceShutdownOptions;
  #task: Promise<void> | undefined;

  constructor(options: ServiceShutdownOptions) {
    this.#options = options;
  }

  isStopping(): boolean {
    return this.#task !== undefined;
  }

  request(signal: StopSignal): void {
    if (this.#task) {
      this.#options.logger.info("service_stop_forced", { signal });
      this.#options.forceExit(signalExitCode(signal));
      return;
    }

    this.#task = this.#shutdown(signal);
    void this.#task
      .catch(() => this.#options.setExitCode(1))
      .catch(() => undefined);
  }

  async wait(): Promise<void> {
    await this.#task;
  }

  async #shutdown(signal: StopSignal): Promise<void> {
    const result = await stopService(
      this.#options.logger,
      signal,
      this.#options.stop,
      Date.now,
      this.#options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    if (result === "timed_out") {
      this.#options.forceExit(1);
      return;
    }
    this.#options.setExitCode(result === "stopped" ? 0 : 1);
  }
}

export function logServiceConfigLoaded(
  logger: InfoLogger,
  allowedUserCount: number,
  streamResponses: boolean,
): void {
  logger.info("service_config_loaded", {
    allowed_user_count: allowedUserCount,
    stream_responses: streamResponses,
  });
}

export function logServiceStarted(logger: InfoLogger, processId: number): void {
  logger.info("service_started", { process_id: processId });
}

export function logServiceStartFailed(
  logger: InfoLogger,
  error: unknown,
): void {
  logger.info("service_start_failed", {
    error_name: errorName(error),
    reason: "startup_failed",
  });
}

export async function runManagedService(
  service: ManagedService,
  logger: InfoLogger,
  shutdown: ServiceShutdownController,
  setExitCode: (code: number) => void,
  forceExit: (code: number) => void,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  try {
    await service.start();
    if (shutdown.isStopping()) {
      await shutdown.wait();
      return;
    }
    throw new Error("Telegram 长轮询意外停止");
  } catch (error) {
    if (shutdown.isStopping()) {
      await shutdown.wait();
      return;
    }
    logServiceStartFailed(logger, error);
    const cleanup = await cleanupFailedStart(
      logger,
      () => service.stop(),
      timeoutMs,
    );
    if (cleanup === "timed_out") {
      forceExit(1);
      return;
    }
    setExitCode(1);
  }
}

export async function stopService(
  logger: InfoLogger,
  signal: StopSignal,
  stop: () => Promise<void>,
  now: () => number = Date.now,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<StopServiceResult> {
  logger.info("service_stop_requested", { signal });
  logger.info("service_stopping", { signal });
  const startedAt = now();
  const outcome = await settleWithin(stop, timeoutMs);
  if (outcome.status === "fulfilled") {
    logger.info("service_stopped", { duration_ms: now() - startedAt });
    return "stopped";
  }
  logger.info("service_stop_failed", {
    error_name:
      outcome.status === "rejected" ? errorName(outcome.error) : "Error",
    reason:
      outcome.status === "rejected" ? "shutdown_failed" : "shutdown_timeout",
  });
  return outcome.status === "rejected" ? "failed" : "timed_out";
}

async function cleanupFailedStart(
  logger: InfoLogger,
  stop: () => Promise<void>,
  timeoutMs: number,
): Promise<StopServiceResult> {
  const outcome = await settleWithin(stop, timeoutMs);
  if (outcome.status === "fulfilled") {
    return "stopped";
  }
  logger.info("service_stop_failed", {
    error_name:
      outcome.status === "rejected" ? errorName(outcome.error) : "Error",
    reason:
      outcome.status === "rejected" ? "shutdown_failed" : "shutdown_timeout",
  });
  return outcome.status === "rejected" ? "failed" : "timed_out";
}

type TimedOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown }
  | { status: "timed_out" };

async function settleWithin(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<TimedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Promise<TimedOutcome>;
  try {
    result = operation().then<TimedOutcome, TimedOutcome>(
      () => ({ status: "fulfilled" }),
      (error: unknown) => ({ status: "rejected", error }),
    );
  } catch (error) {
    return { status: "rejected", error };
  }
  try {
    return await Promise.race([
      result,
      new Promise<TimedOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function signalExitCode(signal: StopSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}
