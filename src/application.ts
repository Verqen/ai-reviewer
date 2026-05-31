import type { IConfig } from "~/shared/config";
import type { FastifyInstance } from "fastify";

import type { AppConfigSchema } from "~/config/app.config";
import type { IJobQueue } from "~/domain/ports/job-queue.port";
import type { ReviewJob } from "~/domain/types/job.types";

class Application {
  static inject = [] as const;

  constructor(
    private readonly app: FastifyInstance,
    private readonly appConfig: IConfig<AppConfigSchema>,
    private readonly queue: IJobQueue<ReviewJob>,
  ) {
    process
      .once("unhandledRejection", (reason) => {
        this.app.log.fatal(reason, "Unhandled rejection!");
        void this.shutdown();
      })
      .once("SIGTERM", (signal) => void this.handleExitSignal(signal))
      .once("SIGINT", (signal) => void this.handleExitSignal(signal))
      .once("SIGQUIT", (signal) => void this.handleExitSignal(signal));
  }

  async init(): Promise<void> {
    await this.app.listen({
      host: this.appConfig.envs.HOST,
      port: this.appConfig.envs.PORT,
    });
  }

  async shutdown(): Promise<void> {
    const timeoutMs = this.appConfig.envs.SHUTDOWN_TIMEOUT_MS;
    const startedAt = Date.now();
    const shutdownTimeout = setTimeout(() => {
      this.app.log.warn(
        { elapsedMs: Date.now() - startedAt, timeoutMs },
        "Shutdown timed out, halting now!",
      );
      process.exit(1);
    }, timeoutMs);

    const inFlight = this.queue.size;

    if (inFlight > 0) {
      this.app.log.info(
        { count: inFlight, timeoutMs },
        "Waiting for in-flight reviews to complete",
      );
      await this.queue.drain();
      this.app.log.info(
        { drainElapsedMs: Date.now() - startedAt },
        "In-flight reviews drained",
      );
    }

    await this.app.close();
    clearTimeout(shutdownTimeout);
  }

  private async handleExitSignal(signal: NodeJS.Signals): Promise<void> {
    this.app.log.warn(`${signal} signal received, shutting down!`);
    await this.shutdown();
    process.exit(0);
  }
}

export { Application };
