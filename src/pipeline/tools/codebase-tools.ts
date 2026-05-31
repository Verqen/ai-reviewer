import type { ToolDefinition } from "~/domain/types/llm.types";

const readFileTool: ToolDefinition = {
  description:
    "Read file content by repository-relative path. Typical flow: use list_files or search_content first to locate the path and line hints, then call read_file with start_line/end_line (and optional max_chars) to fetch a narrow slice instead of entire large files. max_chars cannot exceed the server-side read cap. If the response says File not found, resolve the exact path via list_files or search_content, then retry read_file.",
  name: "read_file",
  parameters: {
    properties: {
      end_line: {
        description: "Optional end line (1-based, inclusive)",
        type: "number",
      },
      max_chars: {
        description:
          "Optional output character cap (clamped to the server max for read_file output)",
        type: "number",
      },
      path: {
        description: "File path relative to the repository root",
        type: "string",
      },
      start_line: {
        description: "Optional start line (1-based, inclusive)",
        type: "number",
      },
    },
    required: ["path"],
    type: "object",
  },
};

const listFilesTool: ToolDefinition = {
  description:
    "List files in the repository matching a glob pattern or directory prefix. Use * for single-level wildcards and ** for recursive. Example: 'src/**/*.ts'",
  name: "list_files",
  parameters: {
    properties: {
      pattern: {
        description:
          "Glob pattern (e.g. 'src/**/*.ts') or directory path (e.g. 'src/utils')",
        type: "string",
      },
    },
    required: ["pattern"],
    type: "object",
  },
};

const searchContentTool: ToolDefinition = {
  description:
    "Search for a text pattern across files in the repository. Returns matching file paths; under each path, every hit is one line in grep -n form: 1-based line number, colon, then the full line text—use these numbers with read_file start_line/end_line and to align with diffs.",
  name: "search_content",
  parameters: {
    properties: {
      glob: {
        description:
          "Optional glob pattern to limit which files are searched (e.g. '*.ts')",
        type: "string",
      },
      pattern: {
        description: "Text string to search for in file contents",
        type: "string",
      },
    },
    required: ["pattern"],
    type: "object",
  },
};

const diffHunkTool: ToolDefinition = {
  description:
    "Rebuild narrow before/after file slices around one unified-diff hunk. Use when the diff shown in the prompt is truncated or you need baseline vs MR-head context matching an allowable-anchor row. Pass path equal to MR newPath for that diff, plus line_number and line_type copied exactly from the anchors table, and optionally context_lines (non-negative integer) for wider window. Responses prefix anchor_used and inclusive baseline_slice/head_slice line ranges—cite code only inside those spans unless you widen context or call read_file.",
  name: "diff_hunk",
  parameters: {
    properties: {
      context_lines: {
        description:
          "Optional lines of baseline/head padding around the hunk (clamped server-side).",
        type: "number",
      },
      line_number: {
        description:
          "Positive line number tied to anchor row (removed → old-side line numbers; otherwise new-side)",
        type: "number",
      },
      line_type: {
        description: "Anchor row type copied from allowable anchors table",
        enum: ["added", "context", "removed"],
        type: "string",
      },
      path: {
        description: "Repository-relative newPath value for this MR diff slice",
        type: "string",
      },
    },
    required: ["path", "line_number", "line_type"],
    type: "object",
  },
};

const codebaseTools: ToolDefinition[] = [
  readFileTool,
  listFilesTool,
  searchContentTool,
];

export { codebaseTools, diffHunkTool };
