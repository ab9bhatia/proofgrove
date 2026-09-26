import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// DatasetActions reads the app router for the durable ?genJob= generation-job
// URL state; these static renders run without a mounted Next router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

import { DatasetModePicker } from "./dataset-mode-picker";
import { GenerationMethodPicker, ImportDatasetLayout } from "./dataset-actions";

describe("dataset controls", () => {
  it("groups imported dataset details and the CSV file into one workspace", () => {
    const html = renderToStaticMarkup(
      createElement(ImportDatasetLayout, {
        name: "support_quality",
        setName: () => undefined,
        productId: "proofgrove",
        setProductId: () => undefined,
        file: null,
        setFile: () => undefined,
        busy: false,
        onDownloadTemplate: () => undefined,
        onCancel: () => undefined,
      }),
    );

    expect(html).toContain("Dataset details");
    expect(html).toContain("CSV file");
    expect(html).toContain("Download Nova agent sample (4 cases)");
    expect(html).toContain("Drop a CSV file here");
    expect(html).toContain("Cancel");
    expect(html).toContain("Import Draft");
  });

  it("exposes the selected onboarding action", () => {
    const html = renderToStaticMarkup(
      createElement(DatasetModePicker, { mode: "generate", onModeChange: () => undefined }),
    );

    expect(html).toContain("Generate");
    expect(html).toContain("Import CSV");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Add dataset"');
    // The column count, not the whole class string — asserting the literal
    // attribute made an unrelated utility class a test failure.
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain('style="max-width:28rem"');
    expect(html).not.toContain('class="inline-grid w-full max-w-sm grid-cols-2');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*aria-describedby="dataset-mode-generate-description"/);
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('<span id="dataset-mode-generate-description" class="sr-only">');
    expect(html).not.toContain('<p id="dataset-mode-');
    expect(html).not.toContain(">Selected<");
    expect(html).not.toContain(">Select<");
  });

  it("makes the selected generation method explicit", () => {
    const html = renderToStaticMarkup(
      createElement(GenerationMethodPicker, {
        value: "llms",
        onChange: () => undefined,
      }),
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Generation method"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*aria-describedby="generation-method-llms-description"/);
    // Same segmented control as the Generate / Import choice above it: no
    // Select/Selected pills, and one description that follows the choice.
    expect(html).not.toContain(">Selected<");
    expect(html).toContain("Generate data using powerful LLMs");
  });

});
