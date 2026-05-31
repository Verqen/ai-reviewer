import type { IReviewFindingRepository } from "~/domain/ports/review-finding.repository.port";
import type {
  PriorFindings,
  PriorFindingsByFile,
  ReviewFinding,
} from "~/domain/types/review.types";

function groupFindingsByFile(
  findings: ReviewFinding[]
): Map<string, ReviewFinding[]> {
  const grouped = new Map<string, ReviewFinding[]>();

  for (const finding of findings) {
    const existing = grouped.get(finding.filePath) ?? [];
    existing.push(finding);
    grouped.set(finding.filePath, existing);
  }

  return grouped;
}

class ReviewHistoryService {
  constructor(private readonly reviewFindingRepo: IReviewFindingRepository) {}

  async loadPriorFindings(
    projectId: number,
    mrIid: number
  ): Promise<PriorFindings> {
    const findings = await this.reviewFindingRepo.findByProjectAndMr(
      projectId,
      mrIid
    );

    return {
      addressed: findings.filter((f) => f.resolution === "addressed"),
      dismissed: findings.filter(
        (f) => f.resolution === "dismissed" || f.resolution === "wont_fix"
      ),
      pending: findings.filter((f) => f.resolution === "pending"),
    };
  }

  async getPendingFindings(
    projectId: number,
    mrIid: number
  ): Promise<ReviewFinding[]> {
    const findings = await this.reviewFindingRepo.findByProjectAndMr(
      projectId,
      mrIid
    );

    return findings.filter((f) => f.resolution === "pending");
  }

  async loadPriorFindingsByFile(
    projectId: number,
    mrIid: number
  ): Promise<PriorFindingsByFile> {
    const findings = await this.loadPriorFindings(projectId, mrIid);

    return {
      addressed: groupFindingsByFile(findings.addressed),
      dismissed: groupFindingsByFile(findings.dismissed),
      pending: groupFindingsByFile(findings.pending),
    };
  }
}

export { ReviewHistoryService };
