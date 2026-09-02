import { BridgeApp } from "./app";
import { loadConfig, resolveConfigPath } from "./config";
import { createInfoLogger } from "./logging/logger";
import {
  logServiceConfigLoaded,
  logServiceStartFailed,
  runManagedService,
  ServiceShutdownController,
} from "./service/lifecycle";

const logger = createInfoLogger();

async function main(): Promise<void> {
  const configPath = resolveConfigPath(Bun.argv.slice(2));
  const config = await loadConfig(configPath);
  logServiceConfigLoaded(
    logger,
    config.telegram.allowedUserIds.length,
    config.telegram.streamResponses,
  );

  const app = await BridgeApp.create(config, logger);
  const shutdown = new ServiceShutdownController({
    logger,
    stop: () => app.stop(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    forceExit: (code) => process.exit(code),
  });
  const onSigint = (): void => shutdown.request("SIGINT");
  const onSigterm = (): void => shutdown.request("SIGTERM");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await runManagedService(
      app,
      logger,
      shutdown,
      (code) => {
        process.exitCode = code;
      },
      (code) => process.exit(code),
    );
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

main().catch((error: unknown) => {
  logServiceStartFailed(logger, error);
  process.exitCode = 1;
});
