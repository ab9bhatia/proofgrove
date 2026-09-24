"use client";

import { FileUp, Sparkles } from "lucide-react";
import { SegmentedChoice } from "@/components/segmented-choice";

export type DatasetOnboardMode = "generate" | "import";

const OPTIONS: {
  id: DatasetOnboardMode;
  label: string;
  desc: string;
  icon: typeof Sparkles;
}[] = [
  {
    id: "generate",
    label: "Generate",
    desc: "Create synthetic evaluation cases with an LLM or grounded agent workflow.",
    icon: Sparkles,
  },
  {
    id: "import",
    label: "Import CSV",
    desc: "Upload an existing CSV golden dataset and continue through review.",
    icon: FileUp,
  },
];

export function DatasetModePicker({
  mode,
  onModeChange,
}: {
  mode: DatasetOnboardMode | null;
  onModeChange: (mode: DatasetOnboardMode | null) => void;
}) {
  return (
    <SegmentedChoice
      options={OPTIONS.map((opt) => ({
        value: opt.id,
        label: opt.label,
        hint: opt.desc,
        icon: opt.icon,
      }))}
      // Not `?? OPTIONS[0]`: with no mode chosen the parent renders no form, so
      // showing Generate as checked invites a click that appears to do nothing.
      value={mode}
      onChange={onModeChange}
      label="Add dataset"
      idPrefix="dataset-mode"
    />
  );
}
