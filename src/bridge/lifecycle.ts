export interface BridgeLifecycleOperations {
  beginShutdown(): void;
  registerCommands(): Promise<void>;
  startPolling(onReady: () => void): Promise<void>;
  stopPolling(): Promise<void>;
  closeIngress(stopPolling: () => Promise<void>): Promise<void>;
  closeAgents(): Promise<void>;
  closeOutbound(): Promise<void>;
  closeDrafts(): Promise<void>;
  closeActivity(): Promise<void>;
}

export class BridgeLifecycle {
  readonly #operations: BridgeLifecycleOperations;
  readonly #pollingInitialized: Promise<void>;
  readonly #resolvePollingInitialized: () => void;
  #startTask: Promise<void> | undefined;
  #stopTask: Promise<void> | undefined;
  #stopping = false;
  #pollingStarted = false;
  #pollingReady = false;

  constructor(operations: BridgeLifecycleOperations) {
    this.#operations = operations;
    let resolvePollingInitialized: (() => void) | undefined;
    this.#pollingInitialized = new Promise<void>((resolve) => {
      resolvePollingInitialized = resolve;
    });
    this.#resolvePollingInitialized = () => resolvePollingInitialized?.();
  }

  start(): Promise<void> {
    if (this.#stopping) {
      return Promise.reject(new Error("服务已经开始关闭"));
    }
    this.#startTask ??= this.#run();
    return this.#startTask;
  }

  stop(): Promise<void> {
    if (this.#stopTask) {
      return this.#stopTask;
    }
    this.#stopping = true;
    this.#operations.beginShutdown();
    this.#stopTask = this.#close();
    return this.#stopTask;
  }

  async #run(): Promise<void> {
    await this.#operations.registerCommands();
    if (this.#stopping) {
      return;
    }
    this.#pollingStarted = true;
    try {
      await this.#operations.startPolling(() => {
        this.#pollingReady = true;
        this.#resolvePollingInitialized();
      });
    } finally {
      this.#resolvePollingInitialized();
    }
  }

  async #close(): Promise<void> {
    const failures: unknown[] = [];
    const polling = [
      callClose(() =>
        this.#operations.closeIngress(() => this.#stopPollingSafely()),
      ),
      ...(this.#startTask ? [this.#startTask] : []),
    ];
    await collectFailures(polling, failures);
    await collectFailures(
      [callClose(() => this.#operations.closeAgents())],
      failures,
    );
    await collectFailures(
      [callClose(() => this.#operations.closeOutbound())],
      failures,
    );
    await collectFailures(
      [
        callClose(() => this.#operations.closeDrafts()),
        callClose(() => this.#operations.closeActivity()),
      ],
      failures,
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "服务关闭不完整");
    }
  }

  async #stopPollingSafely(): Promise<void> {
    if (!this.#pollingStarted) {
      return;
    }
    await this.#pollingInitialized;
    if (this.#pollingReady) {
      await this.#operations.stopPolling();
    }
  }
}

async function collectFailures(
  operations: readonly Promise<void>[],
  failures: unknown[],
): Promise<void> {
  const results = await Promise.allSettled(operations);
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
}

function callClose(operation: () => Promise<void>): Promise<void> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}
