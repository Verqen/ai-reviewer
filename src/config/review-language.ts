import { readRuntimeEnv } from "~/config/runtime.env";

const LANGUAGE_ALIASES: Record<string, string> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  ru: "Russian",
  uk: "Ukrainian",
  "zh-cn": "Chinese",
  "zh-tw": "Traditional Chinese",
};

const DEFAULT_REVIEW_LANGUAGE = "English";

function normalizeLanguage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_REVIEW_LANGUAGE;
  const lookup = LANGUAGE_ALIASES[trimmed.toLowerCase()];
  return lookup ?? trimmed;
}

function getReviewLanguage(): string {
  const raw = readRuntimeEnv().REVIEW_LANGUAGE;
  return raw ? normalizeLanguage(raw) : DEFAULT_REVIEW_LANGUAGE;
}

export { DEFAULT_REVIEW_LANGUAGE, getReviewLanguage, normalizeLanguage };
