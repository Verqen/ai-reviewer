function buildAnalysisDisciplineInstruction(language: string): string {
  return (
    "Discipline (phase 1 analysis): Every risk or issue must be checkable—tie it to specific diff lines (L<number>) and/or to facts you verified with repository tools. " +
    "Avoid generic boilerplate with no code anchor. If a point is a hypothesis, label it explicitly and still anchor to lines or state what tools must verify. " +
    "If you need context beyond the diff (imports, callers, layout), use tools first; do not speculate. " +
    "When the bundled diff excerpt is truncated or missing surrounding lines, prefer diff_hunk: set path to the MR newPath for that file, and copy line_number and line_type from the same row in the allowable anchors table (removed uses baseline/old-side line numbers; added and context use MR-head/new-side numbers—do not mix values from different rows or swap old vs new sides). Typical mistakes: path not equal to newPath, or mismatched anchor fields. Each diff_hunk reply includes anchor_used plus baseline_slice and head_slice inclusive line ranges—treat returned file text as bounded by those ranges; do not assert what lies outside them without read_file or a larger context_lines request. " +
    `When the diff and tool results already support a conclusion, state it concretely in ${language}; do not burn extra tool rounds or pad with vague warnings.`
  );
}

export { buildAnalysisDisciplineInstruction };
