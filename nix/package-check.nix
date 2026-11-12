{
  lib,
  runCommand,
  amadeus,
  runtimePackages,
  writableTmpDirAsHomeHook,
}:
runCommand "amadeus-package-check"
  {
    nativeBuildInputs = [
      amadeus
      writableTmpDirAsHomeHook
    ]
    ++ runtimePackages;
  }
  ''
    export AMADEUS_HOME="$TMPDIR/state"
    cd ${amadeus}/lib/amadeus
    test ! -e node_modules/typescript
    test ! -e node_modules/@types/bun
    test -f src/channels/ipc/client.ts
    test -f ${amadeus}/share/doc/amadeus/config.example.json
    test -f node_modules/quickjs-wasi/quickjs.wasm

    bun run - <<'TS'
    import { strict as assert } from "node:assert";
    import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
    import { createModels } from "@earendil-works/pi-ai/models";
    import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
    import { contentText } from "@earendil-works/pi-ai/utils/text";
    import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
    import { openAgent } from "./src/agent";
    import { parseConfig } from "./src/config";
    import { openIpc } from "./src/channels/ipc";
    import { NotificationEntry, NotificationTask } from "./src/channels/notifications";

    const home = process.env.AMADEUS_HOME;
    assert(home);
    const config = parseConfig({
      channels: { telegram: { token: "1:unused", allowedUserIds: [1] } },
      agent: { model: { provider: "faux", modelId: "test" } },
      providers: { faux: { apiKey: "unused" } },
    }, home);
    const faux = fauxProvider({ models: [{ id: "test", contextWindow: 128000 }] });
    const command = 'set -eu; printf "shell-ok\\n"; bun run "$AMADEUS_NOTIFY_CLI" --key smoke --message notification-ok; amadeus notify --key smoke --message notification-ok';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'const result = await tools.bash({command:' + JSON.stringify(command) + '}); if (result.exitCode !== 0) throw result; text(result.output); text(result.exitCode);' }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
      fauxAssistantMessage("notification handled"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const agent = await openAgent(config, models);
    const stop = new AbortController();
    let running;
    try {
      const image = await agent.images.prepare(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), "image/png", DEFAULT_IMAGE_LIMITS);
      assert(image);
      assert.equal(image.mimeType, "image/png");
      assert(image.data.length > 0);
      const ipc = await openIpc(agent);
      running = ipc.run(stop.signal);
      await agent.restoreSchedules();
      agent.harness.resume();
      const root = await agent.harness.root(context, { agent: agent.configuration });
      const submission = await root.submit({ type: "input", content: "Check the installed runtime" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      await root.waitForIdle(context);
      const notifications = await agent.harness.commit(tx => tx.scanTasks({ kind: NotificationTask.definition.name }, 10), context);
      for (const task of notifications.items) await agent.harness.waitForTask(task.id, context);
      await root.waitForIdle(context);
      const entries = (await root.entries({ order: "ascending" }, 100, undefined, context)).items;
      assert.equal(entries.filter(NotificationEntry.is).length, 1);
      assert.equal(entries.find(NotificationEntry.is)?.data.message, "notification-ok");
      const results = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
      assert(results.some(message => message.toolName === "codemode" && !message.isError && contentText(message.content).includes("shell-ok")));
      assert.equal(faux.state.callCount, 3);
    } finally {
      stop.abort();
      try { await running; } finally { await agent.close(); }
    }
    TS

    touch "$out"
  ''
