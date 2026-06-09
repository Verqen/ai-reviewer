import { z } from "zod";

import {
  OPENROUTER_REVIEW_MODEL,
  OPENROUTER_TRIAGE_MODEL,
} from "~/config/models";

const SeverityThresholdSchema = z.enum([
  "critical",
  "attention",
  "warning",
  "info",
  "nitpick",
]);

const ReviewPipelineConfigSchema = z.object({
  blockMergeOn: z.enum(["critical", "warning", "none"]).default("none"),
  concurrency: z
    .object({
      maxParallelFiles: z.number().int().positive().default(8),
    })
    .default({ maxParallelFiles: 8 }),
  ignore: z.array(z.string()).default([]),
  learning: z
    .object({
      enabled: z.boolean().default(true),
      minOccurrencesToSuppress: z.number().int().positive().default(3),
    })
    .default({ enabled: true, minOccurrencesToSuppress: 3 }),
  modelOverrides: z
    .object({
      review: z.boolean().default(false),
      triage: z.boolean().default(false),
    })
    .default({ review: false, triage: false }),
  models: z
    .object({
      premium: z.string().nullable().default(null),
      review: z.string().default(OPENROUTER_REVIEW_MODEL),
      triage: z.string().default(OPENROUTER_TRIAGE_MODEL),
    })
    .default({
      premium: null,
      review: OPENROUTER_REVIEW_MODEL,
      triage: OPENROUTER_TRIAGE_MODEL,
    }),
  pathRules: z
    .array(
      z.object({
        extraRules: z.string().optional(),
        focus: z.array(z.string()).optional(),
        path: z.string(),
      }),
    )
    .default([]),
  reReviewCooldownMinutes: z.number().int().nonnegative().default(5),
  rulesSource: z.enum(["REVIEW.md (repo)", "REVIEW.md (local)"]).optional(),
  inlineMinConfidence: z.number().min(0).max(1).default(0.7),
  maxFindingsPerFile: z.number().int().positive().default(10),
  maxFindingsPerReview: z.number().int().positive().default(25),
});

const ResolvedReviewPipelineConfigSchema = ReviewPipelineConfigSchema.extend({
  severityThreshold: SeverityThresholdSchema,
});

type LoadedReviewPipelineConfig = z.infer<typeof ReviewPipelineConfigSchema>;
type ReviewPipelineConfig = z.infer<typeof ResolvedReviewPipelineConfigSchema>;

export {
  ResolvedReviewPipelineConfigSchema,
  ReviewPipelineConfigSchema,
  SeverityThresholdSchema,
};
export type { LoadedReviewPipelineConfig, ReviewPipelineConfig };
