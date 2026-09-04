import { errorName, noopInfoLogger, type InfoLogger } from "../logging/logger";
import { parsePiRpcOutput } from "./parser";
import type {
  PiRpcCommand,
  PiRpcCommandRequest,
  PiRpcEvent,
  PiRpcExtensionUiResponse,
  PiRpcResponse,
} from "./types";
import type { PiRpcTransport, PiSessionLaunchMode } from "./transport";

export type PiRpcEventListener = (event: PiRpcEvent) => void;
export type PiRpcFatalListener = (error: Error) => void;

export class PiRpcTransportCloseError extends Error {}

export interface PiRpcRequestHandle {
  sent: Promise<void>;
  response: Promise<PiRpcResponse>;
}

export interface PiRpcClientLike {
  readonly sessionLaunchMode?: PiSessionLaunchMode;
  dispatch(command: PiRpcCommandRequest): PiRpcRequestHandle;
  request(command: PiRpcCommandRequest): Promise<PiRpcResponse>;
  notify(message: PiRpcExtensionUiResponse): Promise<void>;
  onEvent(listener: PiRpcEventListener): () => void;
  onFatal(listener: PiRpcFatalListener): () => void;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve(response: PiRpcResponse): void;
  reject(error: Error): void;
}

export class PiRpcClient implements PiRpcClientLike {
  readonly sessionLaunchMode?: PiSessionLaunchMode;
  readonly #transport: PiRpcTransport;
  readonly #logger: InfoLogger;
  readonly #listeners = new Set<PiRpcEventListener>();
  readonly #fatalListeners = new Set<PiRpcFatalListener>();
  readonly #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    transport: PiRpcTransport,
    logger: InfoLogger = noopInfoLogger,
    sessionLaunchMode?: PiSessionLaunchMode,
  ) {
    this.#transport = transport;
    this.#logger = logger;
    if (sessionLaunchMode !== undefined) {
      this.sessionLaunchMode = sessionLaunchMode;
    }
    void this.#consume().catch(() => undefined);
  }

  dispatch(command: PiRpcCommandRequest): PiRpcRequestHandle {
    if (this.#closed) {
      const failure = Promise.reject(new Error("Pi RPC 客户端已经关闭"));
      return { sent: failure, response: failure };
    }

    const id = String(this.#nextId);
    this.#nextId += 1;
    const request = { ...command, id } as PiRpcCommand;
    const response = new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void response.catch(() => undefined);
    const sent = this.#transport
      .sendLine(JSON.stringify(request))
      .catch((error: unknown) => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      });

    return { sent, response };
  }

  async request(command: PiRpcCommandRequest): Promise<PiRpcResponse> {
    const handle = this.dispatch(command);
    await handle.sent;
    return handle.response;
  }

  async notify(message: PiRpcExtensionUiResponse): Promise<void> {
    if (this.#closed) {
      throw new Error("Pi RPC 客户端已经关闭");
    }
    await this.#transport.sendLine(JSON.stringify(message));
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onFatal(listener: PiRpcFatalListener): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failPending(new Error("Pi RPC 客户端已经关闭"));
    }
    this.#closePromise ??= this.#closeTransport();
    await this.#closePromise;
  }

  async #consume(): Promise<void> {
    try {
      for await (const line of this.#transport.lines()) {
        const output = parsePiRpcOutput(line);
        if (output.type === "response") {
          this.#handleResponse(output);
          continue;
        }
        for (const listener of this.#listeners) {
          try {
            listener(output);
          } catch (error) {
            this.#logger.info("pi_rpc_listener_failed", {
              error_name: errorName(error),
              reason: "event_listener_failed",
            });
          }
        }
      }
      if (!this.#closed) {
        throw new Error("Pi RPC 输出流意外结束");
      }
    } catch (error) {
      this.#closed = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#failPending(failure);
      this.#closePromise ??= this.#closeTransport();
      let reportedFailure = failure;
      try {
        await this.#closePromise;
      } catch (closeError) {
        reportedFailure = new PiRpcTransportCloseError(
          "Pi RPC transport 关闭失败",
          { cause: closeError },
        );
      }
      for (const listener of this.#fatalListeners) {
        try {
          listener(reportedFailure);
        } catch (listenerError) {
          this.#logger.info("pi_rpc_listener_failed", {
            error_name: errorName(listenerError),
            reason: "fatal_listener_failed",
          });
        }
      }
    }
  }

  async #closeTransport(): Promise<void> {
    try {
      await this.#transport.close();
    } catch (error) {
      throw new PiRpcTransportCloseError("Pi RPC transport 关闭失败", {
        cause: error,
      });
    }
  }

  #handleResponse(response: PiRpcResponse): void {
    if (!response.id) {
      this.#failPending(
        new Error(`Pi RPC ${response.command} 响应缺少请求 ID`),
      );
      return;
    }

    const pending = this.#pending.get(response.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.id);
    pending.resolve(response);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
