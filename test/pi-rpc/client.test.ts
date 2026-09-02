import { describe, expect, test } from "bun:test";
import { PiRpcClient, PiRpcTransportCloseError } from "../../src/pi-rpc/client";
import type { PiRpcTransport } from "../../src/pi-rpc/transport";
import { RecordingLogger } from "../helpers/recording-logger";

class FakeTransport implements PiRpcTransport {
  readonly sent: string[] = [];
  readonly #lines: string[];

  constructor(lines: string[]) {
    this.#lines = lines;
  }

  async sendLine(line: string): Promise<void> {
    this.sent.push(line);
  }

  async *lines(): AsyncIterable<string> {
    await Promise.resolve();
    for (const line of this.#lines) {
      yield line;
    }
  }

  async close(): Promise<void> {}
}

class CrashingTransport implements PiRpcTransport {
  #crash: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#crash = resolve;
  });

  async sendLine(): Promise<void> {}

  async *lines(): AsyncIterable<string> {
    await this.#gate;
    throw new Error("subprocess exited");
  }

  crash(): void {
    this.#crash?.();
  }

  async close(): Promise<void> {}
}

class DelayedFatalCloseTransport implements PiRpcTransport {
  #crash: (() => void) | undefined;
  #releaseClose: (() => void) | undefined;
  readonly #crashGate = new Promise<void>((resolve) => {
    this.#crash = resolve;
  });
  readonly #closeGate = new Promise<void>((resolve) => {
    this.#releaseClose = resolve;
  });
  closeStarted = false;

  async sendLine(): Promise<void> {}

  async *lines(): AsyncIterable<string> {
    await this.#crashGate;
    throw new Error("subprocess exited");
  }

  crash(): void {
    this.#crash?.();
  }

  releaseClose(): void {
    this.#releaseClose?.();
  }

  async close(): Promise<void> {
    this.closeStarted = true;
    await this.#closeGate;
  }
}

class FailingCloseTransport implements PiRpcTransport {
  async sendLine(): Promise<void> {}

  async *lines(): AsyncIterable<string> {
    throw new Error("subprocess exited");
  }

  async close(): Promise<void> {
    throw new Error("kill failed");
  }
}

class HangingCloseTransport implements PiRpcTransport {
  async sendLine(): Promise<void> {}

  async *lines(): AsyncIterable<string> {
    await new Promise<never>(() => undefined);
  }

  async close(): Promise<void> {
    await new Promise<never>(() => undefined);
  }
}

describe("PiRpcClient", () => {
  test("关联带 ID 的响应并分发事件", async () => {
    const transport = new FakeTransport([
      '{"type":"agent_start"}',
      '{"type":"response","id":"1","command":"abort","success":true}',
    ]);
    const logger = new RecordingLogger();
    const client = new PiRpcClient(transport, logger);
    const events: string[] = [];
    client.onEvent(() => {
      throw new Error("listener failed with secret payload");
    });
    client.onEvent((event) => events.push(event.type));
    await client.notify({
      type: "extension_ui_response",
      id: "ui-1",
      cancelled: true,
    });

    const response = await client.request({ type: "abort" });

    expect(response.success).toBeTrue();
    expect(JSON.parse(transport.sent[0] ?? "{}")).toEqual({
      type: "extension_ui_response",
      id: "ui-1",
      cancelled: true,
    });
    expect(JSON.parse(transport.sent[1] ?? "{}")).toEqual({
      type: "abort",
      id: "1",
    });
    expect(events).toEqual(["agent_start"]);
    expect(logger.entries).toEqual([
      {
        event: "pi_rpc_listener_failed",
        fields: {
          error_name: "Error",
          reason: "event_listener_failed",
        },
      },
    ]);
    await client.close();
  });

  test("close 在 transport 挂起前先拒绝 pending 请求", async () => {
    const client = new PiRpcClient(new HangingCloseTransport());
    const pending = client.request({ type: "get_entries" });

    void client.close();

    await expect(pending).rejects.toThrow("Pi RPC 客户端已经关闭");
  });

  test("fatal 只在 transport 完成关闭后通知监听器", async () => {
    const transport = new DelayedFatalCloseTransport();
    const client = new PiRpcClient(transport);
    const failures: string[] = [];
    client.onFatal((error) => failures.push(error.message));
    const pending = client.request({ type: "abort" });

    transport.crash();
    await expect(pending).rejects.toThrow("subprocess exited");
    await waitFor(() => transport.closeStarted);
    expect(failures).toEqual([]);

    transport.releaseClose();
    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(["subprocess exited"]);
  });

  test("transport 关闭失败使用专用错误通知 fatal", async () => {
    const client = new PiRpcClient(new FailingCloseTransport());
    const failures: Error[] = [];
    client.onFatal((error) => failures.push(error));

    await waitFor(() => failures.length === 1);

    expect(failures[0]).toBeInstanceOf(PiRpcTransportCloseError);
  });

  test("输出流异常会拒绝 pending 请求并通知 fatal", async () => {
    const transport = new CrashingTransport();
    const client = new PiRpcClient(transport);
    const failures: string[] = [];
    client.onFatal((error) => failures.push(error.message));
    const pending = client.request({ type: "abort" });

    transport.crash();

    await expect(pending).rejects.toThrow("subprocess exited");
    expect(failures).toEqual(["subprocess exited"]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待测试条件超时");
}
