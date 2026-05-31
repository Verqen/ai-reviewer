import type { IDismissedPatternRepository } from "~/domain/ports/dismissed-pattern.repository.port";
import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type { IReviewRunRepository } from "~/domain/ports/review-run.repository.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";

interface ReviewInfraRepoPorts {
  dismissedPatternRepo: IDismissedPatternRepository;
  reviewFindingRepo: IReviewFindingRepository;
  reviewRunRepo: IReviewRunRepository;
  snapshotRepo: ISnapshotRepository;
}

export type { ReviewInfraRepoPorts };
