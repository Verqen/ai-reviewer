import type { OverlayResolutionPathPrefixes as OverlayDeclaredResolutionPathPrefixes } from "~/application/overlay-path-resolution-prefixes";
import {
  OVERLAY_VIEW_DEFAULTS,
  type OverlayViewLimits,
} from "~/config/pipeline.config";
import type { ICodeHost } from "~/domain/ports/code-host.port";
import type { IOverlayView } from "~/domain/ports/overlay-view.port";
import type { ISnapshotRepository } from "~/domain/ports/snapshot.repository.port";
import type { ToolCall } from "~/domain/types/llm.types";
import { matchFilePathGlobWithLiteralPrefix } from "~/glob/match-file-path-glob";
import { collectLineNumberedMatches } from "~/search/collect-line-numbered-matches";

const LIST_ALL_FILES_PATTERN = "**/*";

class OverlayViewService implements IOverlayView {
  private readonly mrFileCache = new Map<string, string>();
  private readonly mrChangedPaths: Set<string>;
  private readonly mrDeletedPaths: Set<string>;
  private readonly mrRelativePathPrefixesForResolution: readonly string[];
  private readonly mrRelativePathSubtreeUsingSrcPrefixes: ReadonlySet<string>;
  private readonly limits: OverlayViewLimits;

  constructor(
    private readonly snapshotRepo: ISnapshotRepository,
    private readonly codeHost: ICodeHost,
    private readonly projectId: number,
    private readonly baselineCommitSha: string,
    private readonly mrHeadSha: string,
    changedFilePaths: string[],
    deletedFilePaths: string[] = [],
    overlayDeclaredResolutionPrefixes: OverlayDeclaredResolutionPathPrefixes,
    limits: OverlayViewLimits = OVERLAY_VIEW_DEFAULTS,
  ) {
    this.limits = limits;
    this.mrChangedPaths = new Set(
      changedFilePaths
        .map((filePath) => this.normalizeRepoPath(filePath))
        .filter((filePath) => filePath.length > 0),
    );
    this.mrDeletedPaths = new Set(
      deletedFilePaths
        .map((filePath) => this.normalizeRepoPath(filePath))
        .filter((filePath) => filePath.length > 0),
    );
    this.mrRelativePathPrefixesForResolution =
      overlayDeclaredResolutionPrefixes.prefixes;
    this.mrRelativePathSubtreeUsingSrcPrefixes = new Set(
      overlayDeclaredResolutionPrefixes.prefixesUsingSrcSubtree,
    );
  }

  async readFile(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number,
    lineRangeExplicitFromTool?: boolean,
  ): Promise<string> {
    const hasExplicitLineRange =
      lineRangeExplicitFromTool !== undefined
        ? lineRangeExplicitFromTool
        : startLine !== undefined || endLine !== undefined;
    const normalizedPath = this.normalizeRepoPath(path);
    const resolution = this.resolveRequestedPath(normalizedPath);
    if (resolution.kind === "ambiguous") {
      return `Ambiguous path: ${path}. Candidates: ${resolution.candidates.join(", ")}`;
    }
    if (resolution.kind === "deleted") {
      return `File not found: ${path}`;
    }
    if (resolution.kind === "changed") {
      const cached = this.mrFileCache.get(resolution.path);

      if (cached !== undefined) {
        return this.sliceAndLimitContent(
          cached,
          startLine,
          endLine,
          maxChars,
          hasExplicitLineRange,
        );
      }

      try {
        const content = await this.codeHost.getFileContent(
          this.projectId,
          this.mrHeadSha,
          resolution.path,
        );
        this.mrFileCache.set(resolution.path, content);
        return this.sliceAndLimitContent(
          content,
          startLine,
          endLine,
          maxChars,
          hasExplicitLineRange,
        );
      } catch {
        return `File not found: ${path}`;
      }
    }
    for (const baselineCandidate of resolution.baselineCandidates) {
      const fromMr = await this.tryGetMrFileContent(baselineCandidate);
      if (fromMr !== null) {
        return this.sliceAndLimitContent(
          fromMr,
          startLine,
          endLine,
          maxChars,
          hasExplicitLineRange,
        );
      }
      const content = await this.snapshotRepo.getFileContent(
        this.projectId,
        this.baselineCommitSha,
        baselineCandidate,
      );
      if (content !== null) {
        return this.sliceAndLimitContent(
          content,
          startLine,
          endLine,
          maxChars,
          hasExplicitLineRange,
        );
      }
    }
    return `File not found: ${path}`;
  }

  private async tryGetMrFileContent(candidate: string): Promise<string | null> {
    try {
      const fromMr = await this.codeHost.getFileContent(
        this.projectId,
        this.mrHeadSha,
        candidate,
      );
      this.mrFileCache.set(candidate, fromMr);
      return fromMr;
    } catch {
      return null;
    }
  }

  async readFileAtBaseline(
    path: string,
    startLine?: number,
    endLine?: number,
    maxChars?: number,
    lineRangeExplicitFromTool?: boolean,
  ): Promise<string> {
    const hasExplicitLineRange =
      lineRangeExplicitFromTool !== undefined
        ? lineRangeExplicitFromTool
        : startLine !== undefined || endLine !== undefined;
    const normalizedPath = this.normalizeRepoPath(path);
    const resolution = this.resolveRequestedPath(normalizedPath);
    if (resolution.kind === "ambiguous") {
      return `Ambiguous path: ${path}. Candidates: ${resolution.candidates.join(", ")}`;
    }
    const candidates =
      resolution.kind === "deleted"
        ? [resolution.path]
        : resolution.kind === "changed"
          ? [resolution.path]
          : resolution.baselineCandidates;
    for (const candidatePath of candidates) {
      let content: string | null = await this.snapshotRepo.getFileContent(
        this.projectId,
        this.baselineCommitSha,
        candidatePath,
      );
      if (content === null) {
        try {
          content = await this.codeHost.getFileContent(
            this.projectId,
            this.baselineCommitSha,
            candidatePath,
          );
        } catch {
          content = null;
        }
      }
      if (content !== null) {
        return this.sliceAndLimitContent(
          content,
          startLine,
          endLine,
          maxChars,
          hasExplicitLineRange,
        );
      }
    }
    return `File not found at baseline ref: ${path}`;
  }

  async listFiles(pattern?: string): Promise<string> {
    const normalizedPattern = this.normalizeListFilesPattern(pattern);
    const baselineFiles = await this.snapshotRepo.listFiles(
      this.projectId,
      this.baselineCommitSha,
      normalizedPattern === LIST_ALL_FILES_PATTERN
        ? undefined
        : normalizedPattern,
    );

    const fileSet = new Set(baselineFiles);

    for (const deleted of this.mrDeletedPaths) {
      fileSet.delete(deleted);
    }

    for (const changed of this.mrChangedPaths) {
      if (this.matchesPattern(changed, normalizedPattern)) {
        fileSet.add(changed);
      }
    }

    const sorted = [...fileSet].sort();

    if (sorted.length > this.limits.maxListFiles) {
      return `${sorted.slice(0, this.limits.maxListFiles).join("\n")}\n... and ${sorted.length - this.limits.maxListFiles} more files`;
    }

    if (sorted.length === 0) {
      return `No files matching: ${normalizedPattern}`;
    }

    return this.limitToolResponse(sorted.join("\n"));
  }

  async searchContent(pattern: string, glob?: string): Promise<string> {
    const baselineResults = await this.snapshotRepo.searchContent(
      this.projectId,
      this.baselineCommitSha,
      pattern,
      glob,
    );

    const resultMap = new Map<string, string[]>();

    for (const result of baselineResults) {
      if (
        !this.mrChangedPaths.has(result.filePath) &&
        !this.mrDeletedPaths.has(result.filePath)
      ) {
        resultMap.set(
          result.filePath,
          result.matches.slice(0, this.limits.maxMatchesPerFile),
        );
      }
    }

    for (const changedPath of this.mrChangedPaths) {
      if (glob && !this.matchesPattern(changedPath, glob)) {
        continue;
      }

      const content = await this.readFile(changedPath);

      if (content.startsWith("File not found:")) {
        continue;
      }

      const matches = collectLineNumberedMatches(content, pattern);

      if (matches.length > 0) {
        resultMap.set(
          changedPath,
          matches.slice(0, this.limits.maxMatchesPerFile),
        );
      }
    }

    const entries = [...resultMap.entries()]
      .slice(0, this.limits.maxSearchResults)
      .map(
        ([filePath, matches]) => `--- ${filePath} ---\n${matches.join("\n")}`,
      );

    if (entries.length === 0) {
      return `No matches found for: ${pattern}`;
    }

    const total = resultMap.size;
    const shown = Math.min(total, this.limits.maxSearchResults);
    const header =
      total > shown
        ? `Showing ${shown} of ${total} files matching "${pattern}":\n\n`
        : "";

    return this.limitToolResponse(header + entries.join("\n\n"));
  }

  createToolExecutor(): (call: ToolCall) => Promise<string> {
    return async (call: ToolCall): Promise<string> => {
      const argumentsRecord = this.getArgumentsRecord(call.arguments);
      if (argumentsRecord === null) {
        return this.buildInvalidArgumentsError(
          call.name,
          "Arguments payload must be an object.",
        );
      }
      switch (call.name) {
        case "read_file":
          return this.executeReadFile(argumentsRecord);

        case "list_files":
          return this.executeListFiles(argumentsRecord);

        case "search_content":
          return this.executeSearchContent(argumentsRecord);

        default:
          return `Unknown tool: ${call.name}`;
      }
    };
  }

  private executeReadFile(
    argumentsRecord: Record<string, unknown>,
  ): Promise<string> {
    const path = this.getRequiredStringArgument(argumentsRecord, "path");
    if (path === null) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "read_file",
          'Field "path" must be a non-empty string.',
        ),
      );
    }
    const startLine = this.getOptionalPositiveIntegerArgument(
      argumentsRecord,
      "start_line",
    );
    if (startLine === null && Object.hasOwn(argumentsRecord, "start_line")) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "read_file",
          'Field "start_line" must be a positive integer when provided.',
        ),
      );
    }
    const endLine = this.getOptionalPositiveIntegerArgument(
      argumentsRecord,
      "end_line",
    );
    if (endLine === null && Object.hasOwn(argumentsRecord, "end_line")) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "read_file",
          'Field "end_line" must be a positive integer when provided.',
        ),
      );
    }
    const maxChars = this.getOptionalPositiveIntegerArgument(
      argumentsRecord,
      "max_chars",
    );
    if (maxChars === null && Object.hasOwn(argumentsRecord, "max_chars")) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "read_file",
          'Field "max_chars" must be a positive integer when provided.',
        ),
      );
    }
    const hasExplicitLineRange =
      Object.hasOwn(argumentsRecord, "start_line") ||
      Object.hasOwn(argumentsRecord, "end_line");
    return this.readFile(
      this.normalizeRepoPath(path),
      startLine ?? undefined,
      endLine ?? undefined,
      maxChars ?? undefined,
      hasExplicitLineRange,
    ).then((body) => this.applyReadFileToolResponseLimit(body));
  }

  private executeListFiles(
    argumentsRecord: Record<string, unknown>,
  ): Promise<string> {
    const pattern = this.getOptionalStringArgument(argumentsRecord, "pattern");
    if (pattern === null && Object.hasOwn(argumentsRecord, "pattern")) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "list_files",
          'Field "pattern" must be a string when provided.',
        ),
      );
    }
    return this.listFiles(pattern ?? undefined);
  }

  private executeSearchContent(
    argumentsRecord: Record<string, unknown>,
  ): Promise<string> {
    const pattern = this.getRequiredStringArgument(argumentsRecord, "pattern");
    if (pattern === null) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "search_content",
          'Field "pattern" must be a non-empty string.',
        ),
      );
    }
    const glob = this.getOptionalStringArgument(argumentsRecord, "glob");
    if (glob === null && Object.hasOwn(argumentsRecord, "glob")) {
      return Promise.resolve(
        this.buildInvalidArgumentsError(
          "search_content",
          'Field "glob" must be a string when provided.',
        ),
      );
    }
    return this.searchContent(pattern, glob ?? undefined);
  }

  private getArgumentsRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getRequiredStringArgument(
    argumentsRecord: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = argumentsRecord[key];
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private getOptionalStringArgument(
    argumentsRecord: Record<string, unknown>,
    key: string,
  ): string | null | undefined {
    const value = argumentsRecord[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      return null;
    }
    return value.trim();
  }

  private getOptionalPositiveIntegerArgument(
    argumentsRecord: Record<string, unknown>,
    key: string,
  ): number | null | undefined {
    const value = argumentsRecord[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return null;
    }
    return value;
  }

  private normalizeListFilesPattern(pattern: string | undefined): string {
    if (typeof pattern !== "string") {
      return LIST_ALL_FILES_PATTERN;
    }
    const trimmed = pattern.trim();
    return trimmed.length === 0 ? LIST_ALL_FILES_PATTERN : trimmed;
  }

  private normalizeRepoPath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      return "";
    }
    return trimmed
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/");
  }

  private getDirectCandidates(normalizedPath: string): string[] {
    const candidates = new Set<string>();
    candidates.add(normalizedPath);
    for (const prefixSegment of this.mrRelativePathPrefixesForResolution) {
      if (
        normalizedPath !== prefixSegment &&
        !normalizedPath.startsWith(`${prefixSegment}/`)
      )
        candidates.add(`${prefixSegment}/${normalizedPath}`);
    }
    for (const subtreeMarkedPrefixCandidate of this
      .mrRelativePathSubtreeUsingSrcPrefixes) {
      const subtreeMarkedSrcMountPath = `${subtreeMarkedPrefixCandidate}/src`;
      if (
        normalizedPath.startsWith(`${subtreeMarkedSrcMountPath}/`) ||
        normalizedPath === subtreeMarkedSrcMountPath
      )
        continue;
      candidates.add(`${subtreeMarkedSrcMountPath}/${normalizedPath}`);
    }
    return [...candidates].filter((candidatePath) => candidatePath.length > 0);
  }

  private collectSuffixMatches(
    normalizedPath: string,
    source: ReadonlySet<string>,
  ): string[] {
    const suffix = `/${normalizedPath}`;
    const matches: string[] = [];
    for (const candidate of source) {
      if (candidate === normalizedPath || candidate.endsWith(suffix)) {
        matches.push(candidate);
      }
    }
    return matches;
  }

  private resolveRequestedPath(
    normalizedPath: string,
  ):
    | { kind: "ambiguous"; candidates: string[] }
    | { kind: "changed"; path: string }
    | { kind: "deleted"; path: string }
    | { baselineCandidates: string[]; kind: "baseline" } {
    const directCandidates = this.getDirectCandidates(normalizedPath);
    const changedCandidates = new Set<string>();
    for (const candidate of directCandidates) {
      if (this.mrChangedPaths.has(candidate)) {
        changedCandidates.add(candidate);
      }
    }
    for (const candidate of this.collectSuffixMatches(
      normalizedPath,
      this.mrChangedPaths,
    )) {
      changedCandidates.add(candidate);
    }
    if (changedCandidates.size > 1) {
      return { candidates: [...changedCandidates].sort(), kind: "ambiguous" };
    }
    const changedPath = [...changedCandidates][0];
    if (changedPath) {
      return { kind: "changed", path: changedPath };
    }
    const deletedCandidates = new Set<string>();
    for (const candidate of directCandidates) {
      if (this.mrDeletedPaths.has(candidate)) {
        deletedCandidates.add(candidate);
      }
    }
    for (const candidate of this.collectSuffixMatches(
      normalizedPath,
      this.mrDeletedPaths,
    )) {
      deletedCandidates.add(candidate);
    }
    if (deletedCandidates.size > 1) {
      return { candidates: [...deletedCandidates].sort(), kind: "ambiguous" };
    }
    const deletedPath = [...deletedCandidates][0];
    if (deletedPath) {
      return { kind: "deleted", path: deletedPath };
    }
    return { baselineCandidates: directCandidates, kind: "baseline" };
  }

  private buildInvalidArgumentsError(toolName: string, detail: string): string {
    return `Invalid arguments for ${toolName}: ${detail}`;
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    return matchFilePathGlobWithLiteralPrefix(filePath, pattern);
  }

  private applyReadFileToolResponseLimit(body: string): string {
    const limit = this.limits.maxToolResponseChars;
    if (body.length <= limit) {
      return body;
    }
    const total = body.length;
    const truncated = body.slice(0, limit);
    const prefix = `[read_file] response truncated at tool output cap; total_chars_before=${String(total)} limit=${String(limit)}`;
    return `${prefix}\n${truncated}\n[truncation:tool_response_chars] limit=${String(limit)} total=${String(total)}`;
  }

  private limitToolResponse(value: string): string {
    const limit = this.limits.maxToolResponseChars;
    if (value.length <= limit) {
      return value;
    }
    const total = value.length;
    return `${value.slice(0, limit)}\n[truncation:tool_response_chars] limit=${String(limit)} total=${String(total)}`;
  }

  private sliceAndLimitContent(
    content: string,
    startLine: number | undefined,
    endLine: number | undefined,
    maxChars: number | undefined,
    hasExplicitLineRange: boolean,
  ): string {
    const lines = content.split("\n");
    const totalFileLines = lines.length;
    const startIndex = Math.max(0, (startLine ?? 1) - 1);
    const endIndex = Math.min(lines.length, endLine ?? lines.length);
    const requestedRangeStart = startIndex + 1;
    const requestedRangeEnd = endIndex;
    const selectedLines = lines.slice(startIndex, endIndex);
    const wasTruncatedByLines =
      selectedLines.length > this.limits.maxReadFileLines;
    const linesWithinLimit = wasTruncatedByLines
      ? selectedLines.slice(0, this.limits.maxReadFileLines)
      : selectedLines;
    const selectedJoined = linesWithinLimit.join("\n");
    const effectiveLimit = Math.min(
      maxChars ?? this.limits.maxReadFileChars,
      this.limits.maxReadFileChars,
    );
    const wasTruncatedByChars = selectedJoined.length > effectiveLimit;
    const contentWithinLimit = wasTruncatedByChars
      ? selectedJoined.slice(0, effectiveLimit)
      : selectedJoined;
    const visibleStartLine = linesWithinLimit.length > 0 ? startIndex + 1 : 0;
    const visibleEndLine = startIndex + linesWithinLimit.length;
    const needsPrefix =
      hasExplicitLineRange || wasTruncatedByLines || wasTruncatedByChars;
    const prefixParts: string[] = [];
    if (needsPrefix) {
      const meta: string[] = [
        "[read_file]",
        `total_file_lines=${String(totalFileLines)}`,
      ];
      if (hasExplicitLineRange) {
        meta.push(
          `requested_line_range=${String(requestedRangeStart)}-${String(requestedRangeEnd)}`,
        );
      }
      if (visibleStartLine > 0) {
        meta.push(
          `visible_line_range=${String(visibleStartLine)}-${String(visibleEndLine)}`,
        );
      } else {
        meta.push("visible_line_range=none");
      }
      prefixParts.push(meta.join(" "));
    }
    const truncationNotices: string[] = [];
    if (wasTruncatedByLines) {
      truncationNotices.push(
        `[truncation:read_file_lines] limit=${String(this.limits.maxReadFileLines)} lines_in_window=${String(selectedLines.length)} visible_line_range=${String(visibleStartLine)}-${String(visibleEndLine)}`,
      );
    }
    if (wasTruncatedByChars) {
      truncationNotices.push(
        `[truncation:read_file_chars] effective_limit=${String(effectiveLimit)} size_before_truncation=${String(selectedJoined.length)}`,
      );
    }
    const bodyChunks: string[] = [];
    if (prefixParts.length > 0) {
      bodyChunks.push(prefixParts.join("\n"));
    }
    bodyChunks.push(contentWithinLimit);
    const joinedBody = bodyChunks.join("\n");
    if (truncationNotices.length === 0) {
      return joinedBody;
    }
    return `${joinedBody}\n${truncationNotices.join("\n")}`;
  }
}

export { OverlayViewService };
