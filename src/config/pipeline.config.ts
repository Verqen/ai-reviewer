import { Config } from "~/shared/config";
import { z } from "zod";

import { booleanEnv } from "~/config/boolean-env";
import {
  DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS,
  DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES,
  DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS,
  DEFAULT_COMMENT_RESPONSE_MAX_DIFF_LENGTH,
  DEFAULT_COMMENT_RESPONSE_MAX_TOOL_ROUNDS,
  DEFAULT_COMMENT_RESPONSE_PROMPT_HARD_LIMIT,
  DEFAULT_FILE_REVIEW_MAX_DIFF_CHARACTERS,
  DEFAULT_FINDING_THREAD_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS,
  DEFAULT_FINDING_THREAD_PROMPT_HARD_LIMIT,
  DEFAULT_FORCE_PUSH_LINE_MATCH_TAB_WIDTH,
  DEFAULT_FORCE_PUSH_LINE_WINDOW,
  DEFAULT_LINE_SHIFT_DEDUP_TOLERANCE,
  DEFAULT_REVIEW_BASELINE_POLL_MS,
  DEFAULT_REVIEW_BASELINE_READY_TIMEOUT_MS,
  DEFAULT_REVIEW_CROSS_FILE_PROMPT_HARD_LIMIT,
  DEFAULT_REVIEW_FILE_PROMPT_HARD_LIMIT,
  DEFAULT_REVIEW_TRIAGE_PROMPT_HARD_LIMIT,
  DEFAULT_RUN_STUCK_AFTER_MS,
  DEFAULT_THREAD_PRIOR_FINDINGS_MAX_CHARS,
} from "~/config/constants";
import { optionalEnv } from "~/config/optional-env";

const SeverityEnum = z.enum([
  "critical",
  "attention",
  "warning",
  "info",
  "nitpick",
]);

const OVERLAY_VIEW_DEFAULTS = {
  maxListFiles: 200,
  maxMatchesPerFile: 5,
  maxReadFileChars: 6000,
  maxReadFileLines: 300,
  maxSearchResults: 20,
  maxToolResponseChars: 8000,
} as const;

type OverlayViewLimits = {
  readonly maxSearchResults: number;
  readonly maxMatchesPerFile: number;
  readonly maxListFiles: number;
  readonly maxReadFileChars: number;
  readonly maxReadFileLines: number;
  readonly maxToolResponseChars: number;
};

const PipelineConfigSchema = z.object({
  ARCHITECTURE_SNAPSHOT_ENABLED: booleanEnv(true),
  ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS),
  ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES),
  ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS),
  COMMENT_RESPONSE_MAX_DIFF_LENGTH: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_COMMENT_RESPONSE_MAX_DIFF_LENGTH),
  COMMENT_RESPONSE_MAX_TOOL_ROUNDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_COMMENT_RESPONSE_MAX_TOOL_ROUNDS),
  COMMENT_RESPONSE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_COMMENT_RESPONSE_PROMPT_HARD_LIMIT),
  FILE_REVIEW_MAX_DIFF_CHARACTERS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_FILE_REVIEW_MAX_DIFF_CHARACTERS),
  FINDING_THREAD_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_FINDING_THREAD_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS),
  FINDING_THREAD_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_FINDING_THREAD_PROMPT_HARD_LIMIT),
  FORCE_PUSH_LINE_MATCH_TAB_WIDTH: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_FORCE_PUSH_LINE_MATCH_TAB_WIDTH),
  FORCE_PUSH_LINE_WINDOW: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_FORCE_PUSH_LINE_WINDOW),
  LINE_SHIFT_DEDUP_TOLERANCE: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_LINE_SHIFT_DEDUP_TOLERANCE),
  OVERLAY_MAX_LIST_FILES: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxListFiles),
  OVERLAY_MAX_MATCHES_PER_FILE: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxMatchesPerFile),
  OVERLAY_MAX_READ_FILE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxReadFileChars),
  OVERLAY_MAX_READ_FILE_LINES: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxReadFileLines),
  OVERLAY_MAX_SEARCH_RESULTS: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxSearchResults),
  OVERLAY_MAX_TOOL_RESPONSE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(OVERLAY_VIEW_DEFAULTS.maxToolResponseChars),
  REVIEW_BASELINE_POLL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REVIEW_BASELINE_POLL_MS),
  REVIEW_BASELINE_READY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REVIEW_BASELINE_READY_TIMEOUT_MS),
  REVIEW_CROSS_FILE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REVIEW_CROSS_FILE_PROMPT_HARD_LIMIT),
  REVIEW_FILE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REVIEW_FILE_PROMPT_HARD_LIMIT),
  REVIEW_TRIAGE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REVIEW_TRIAGE_PROMPT_HARD_LIMIT),
  RUN_STUCK_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_RUN_STUCK_AFTER_MS),
  REVIEW_MAX_COST_USD: optionalEnv(z.coerce.number().positive()),
  SEVERITY_THRESHOLD: SeverityEnum.default("info"),
  THREAD_PRIOR_FINDINGS_MAX_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_THREAD_PRIOR_FINDINGS_MAX_CHARS),
});

type PipelineConfigSchema = z.infer<typeof PipelineConfigSchema>;

class PipelineConfig extends Config<PipelineConfigSchema> {
  constructor(envs?: PipelineConfigSchema) {
    super(() => envs ?? PipelineConfigSchema.parse(process.env));
  }
}

export { OVERLAY_VIEW_DEFAULTS, PipelineConfig, PipelineConfigSchema };
export type { OverlayViewLimits };
