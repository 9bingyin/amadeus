import type { Harness } from "@earendil-works/pi-durable";
import type { Agent } from "../agent";
import type { Config } from "../config";
import { openIpc } from "./ipc";
import { openTelegram } from "./telegram";

export type Channel = {
  /** 停止接入时正常返回，真实故障原样抛出；不关闭共享 Harness。 */
  run(signal: AbortSignal): Promise<void>;
};

export async function openChannels(
  agent: Agent,
  config: Config["channels"],
): Promise<Channel[]> {
  const channels: Channel[] = [];
  try {
    if (config.telegram)
      channels.push(await openTelegram(agent, config.telegram));
    channels.push(await openIpc(agent));
    return channels;
  } catch (error) {
    const results = await Promise.allSettled(
      channels.map((channel) => channel.run(AbortSignal.abort())),
    );
    for (const result of results)
      if (result.status === "rejected") console.error(result.reason);
    throw error;
  }
}

export async function runChannels(
  channels: readonly Channel[],
  harness: Harness,
): Promise<void> {
  const controller = new AbortController();
  const stopped = Promise.withResolvers<void>();
  function stop(): void {
    if (!controller.signal.aborted) console.info("Stopping channels");
    controller.abort();
    stopped.resolve();
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let running: Promise<void>[] = [];
  let failure: { error: unknown } | undefined;
  try {
    running = channels.map(async (channel) => channel.run(controller.signal));
    harness.resume();
    console.info("Runtime resumed");
    await Promise.race([
      ...running,
      stopped.promise,
      harness.closed.then((end) => {
        if (end.kind === "failed") throw end.error;
      }),
    ]);
  } catch (error) {
    failure = { error };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stop();
    // 等所有接入停止后再交还 Agent 生命周期；保留首先观察到的原始错误。
    for (const result of await Promise.allSettled(running)) {
      if (result.status !== "rejected") continue;
      if (failure === undefined) failure = { error: result.reason };
      else if (result.reason !== failure.error) console.error(result.reason);
    }
  }
  if (failure) throw failure.error;
  console.info("Channels stopped");
}
