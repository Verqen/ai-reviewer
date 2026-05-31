import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import { createInjector } from "typed-inject";

import { InfraPortsTokens } from "~/di/infra-ports-tokens";
import { InjectionTokens } from "~/di/injection-tokens";
import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import { DismissedPatternRepository } from "~/infrastructure/database/repositories/dismissed-pattern.repository";
import { ReviewFindingRepository } from "~/infrastructure/database/repositories/review-finding.repository";
import { ReviewRunRepository } from "~/infrastructure/database/repositories/review-run.repository";
import { SnapshotRepository } from "~/infrastructure/database/repositories/snapshot.repository";
import type { Database } from "~/infrastructure/database/types";

class InfraRepoPorts {
  static inject = [InjectionTokens.Database, InjectionTokens.Logger] as const;

  constructor(
    db: Kysely<Database>,
    logger: FastifyBaseLogger,
    private readonly injector = createInjector()
      .provideValue(InjectionTokens.Database, db)
      .provideValue(InjectionTokens.Logger, logger)
      .provideClass(InfraPortsTokens.ReviewRunRepo, ReviewRunRepository)
      .provideClass(InfraPortsTokens.ReviewFindingRepo, ReviewFindingRepository)
      .provideClass(InfraPortsTokens.SnapshotRepo, SnapshotRepository)
      .provideClass(
        InfraPortsTokens.DismissedPatternRepo,
        DismissedPatternRepository
      )
  ) {}

  get reviewRunRepo(): IReviewRunRepository {
    return this.injector.resolve(InfraPortsTokens.ReviewRunRepo);
  }

  get reviewFindingRepo(): IReviewFindingRepository {
    return this.injector.resolve(InfraPortsTokens.ReviewFindingRepo);
  }

  get snapshotRepo(): ISnapshotRepository {
    return this.injector.resolve(InfraPortsTokens.SnapshotRepo);
  }

  get dismissedPatternRepo(): IDismissedPatternRepository {
    return this.injector.resolve(InfraPortsTokens.DismissedPatternRepo);
  }
}

export { InfraRepoPorts };
