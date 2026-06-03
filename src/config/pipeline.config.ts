import { Config } from "~/shared/config";
import { z } from "zod";

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
  ARCHITECTURE_SNAPSHOT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  ARCHITECTURE_SNAPSHOT_MAX_FILE_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(8000),
  ARCHITECTURE_SNAPSHOT_MAX_LIST_FILES: z.coerce
    .number()
    .int()
    .positive()
    .default(200),
  ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(40_000),
  COMMENT_RESPONSE_MAX_DIFF_LENGTH: z.coerce
    .number()
    .int()
    .positive()
    .default(200_000),
  COMMENT_RESPONSE_MAX_TOOL_ROUNDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  COMMENT_RESPONSE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(8_000),
  FILE_REVIEW_MAX_DIFF_CHARACTERS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  FINDING_THREAD_ARCHITECTURE_SNAPSHOT_MAX_TOTAL_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  FINDING_THREAD_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  FORCE_PUSH_LINE_MATCH_TAB_WIDTH: z.coerce
    .number()
    .int()
    .positive()
    .default(4),
  FORCE_PUSH_LINE_WINDOW: z.coerce.number().int().positive().default(20),
  LINE_SHIFT_DEDUP_TOLERANCE: z.coerce.number().int().nonnegative().default(3),
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
  REVIEW_BASELINE_POLL_MS: z.coerce.number().int().positive().default(400),
  REVIEW_BASELINE_READY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  REVIEW_CROSS_FILE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  REVIEW_FILE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  REVIEW_TRIAGE_PROMPT_HARD_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  RUN_STUCK_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  SEVERITY_THRESHOLD: SeverityEnum.default("info"),
  THREAD_PRIOR_FINDINGS_MAX_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(4000),
});

type PipelineConfigSchema = z.infer<typeof PipelineConfigSchema>;

class PipelineConfig extends Config<PipelineConfigSchema> {
  constructor() {
    super(() => PipelineConfigSchema.parse(process.env));
  }
}

export { OVERLAY_VIEW_DEFAULTS, PipelineConfig };
export type { OverlayViewLimits, PipelineConfigSchema };
