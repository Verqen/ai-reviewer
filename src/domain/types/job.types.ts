import type { CommentContext, TriggerType } from "~/domain/types/review.types";

type ReviewJob =
  | {
      type: "full_review";
      projectId: number;
      mrIid: number;
      triggerType: TriggerType;

      previousRunId?: string | undefined;
    }
  | {
      type: "incremental_review";
      projectId: number;
      mrIid: number;
      triggerType: "push" | "force_push" | "rebase";
      previousSha: string;
      newHeadSha: string;
    }
  | {
      type: "comment_response";
      projectId: number;
      mrIid: number;
      context: CommentContext;
    }
  | {
      type: "bootstrap_baseline";
      projectId: number;
    }
  | {
      type: "update_baseline";
      projectId: number;
      commitSha: string;
      changedFiles: string[];
      defaultBranch: string;
    }
  | {
      type: "main_push_re_review";
      projectId: number;
      commitSha: string;
      changedFiles: string[];
      defaultBranch: string;
    }
  | {
      type: "main_push_scoped_review";
      projectId: number;
      mrIid: number;
      changedFiles: string[];
      previousRunId: string;
    }
  | {
      type: "thread_response";
      projectId: number;
      mrIid: number;
      discussionId: string;
      noteBody: string;
      authorUsername: string;
    };

export type { ReviewJob };
