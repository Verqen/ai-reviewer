import { matchFilePathGlob } from "~/glob/match-file-path-glob";

type PathRuleEntry = {
  extraRules?: string | undefined;
  path: string;
};

function getPathRulesTextForFile(
  filePath: string,
  pathRules: ReadonlyArray<PathRuleEntry>
): string | null {
  const normalizedPath: string = filePath.replace(/\\/g, "/");
  const matchedRules: PathRuleEntry[] = pathRules.filter(
    (rule) => rule.path !== "**" && matchFilePathGlob(normalizedPath, rule.path)
  );
  const mergedRules: string = matchedRules
    .map((rule) => rule.extraRules?.trim())
    .filter((rule): rule is string => Boolean(rule))
    .join("\n\n");
  return mergedRules || null;
}

type ResolveProjectAndPathRulesTextParams = {
  filePaths: ReadonlyArray<string>;
  pathRules: ReadonlyArray<PathRuleEntry>;
};

type ProjectAndPathRulesText = {
  pathRules: string | null;
  projectRules: string | null;
};

/**
 * Splits the `**` glob into projectRules and deduplicated merged path rules
 * across all given file paths (same semantics as per-file file-review).
 */
function resolveProjectAndPathRulesText(
  params: ResolveProjectAndPathRulesTextParams
): ProjectAndPathRulesText {
  const { filePaths, pathRules } = params;
  const projectRaw: string | undefined = pathRules.find(
    (rule) => rule.path === "**"
  )?.extraRules;
  const projectTrimmed: string = projectRaw?.trim() ?? "";
  const projectRules: string | null = projectTrimmed || null;
  const uniquePathTexts: Set<string> = new Set();
  for (const filePath of filePaths) {
    const perFile: string | null = getPathRulesTextForFile(filePath, pathRules);
    if (perFile) {
      uniquePathTexts.add(perFile);
    }
  }
  const pathRulesJoined: string = [...uniquePathTexts].join("\n\n");
  return {
    pathRules: pathRulesJoined || null,
    projectRules,
  };
}

export { getPathRulesTextForFile, resolveProjectAndPathRulesText };
