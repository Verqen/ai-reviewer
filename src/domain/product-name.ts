const DEFAULT_PRODUCT_NAME = "AI Reviewer";

interface ProductNameOption {
  productName?: string | undefined;
}

function resolveProductName(productName: string | undefined): string {
  const trimmed = productName?.trim() ?? "";
  return trimmed === "" ? DEFAULT_PRODUCT_NAME : trimmed;
}

export { DEFAULT_PRODUCT_NAME, resolveProductName };
export type { ProductNameOption };
