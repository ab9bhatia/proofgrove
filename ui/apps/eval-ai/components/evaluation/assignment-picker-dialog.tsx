"use client";

import { useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Button } from "@evalai/shared/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@evalai/shared/utils";
import type { EvaluationAssignmentVersion } from "@/lib/api";
import { Chip } from "@/components/status-badge";
import { formatDateTime } from "@/lib/format-time";

export function filterAssignments(
  assignments: EvaluationAssignmentVersion[],
  query: string,
): EvaluationAssignmentVersion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return assignments;
  return assignments.filter((item) =>
    [item.name, item.profile_id, item.gate_policy_id ?? "", item.purpose ?? "", item.owner ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * A table, not a dropdown.
 *
 * An Assignment is distinguished by four things — the Profile it scores with,
 * the Gate Policy it is judged against, when it was made, and whether it can
 * carry release evidence. A select option is one line, so the list read as the
 * same generated name repeated seven times with the distinguishing facts
 * truncated. Columns give each fact its own place, and search makes a long list
 * usable. Same shape as the dataset and agent pickers.
 */
export function AssignmentPickerDialog({
  assignments,
  selectedKey,
  onSelect,
  onClear,
  onClose,
}: {
  assignments: EvaluationAssignmentVersion[];
  selectedKey: string | null;
  onSelect: (assignment: EvaluationAssignmentVersion) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterAssignments(assignments, query), [assignments, query]);

  return (
    <Dialog
      variant="modal"
      labelledBy="assignment-picker-title"
      describedBy="assignment-picker-description"
      scrimLabel="Close Assignment picker"
      onClose={onClose}
      initialFocusRef={searchRef}
      width="w-[min(56rem,calc(100vw-2rem))]"
    >
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 id="assignment-picker-title" className="text-lg font-semibold">Choose an Assignment</h2>
          <p id="assignment-picker-description" className="mt-0.5 text-xs text-muted-foreground">
            An Assignment pins the Quality Profile, Gate Policy and target this run is judged by.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Assignment picker">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="border-b px-5 py-3">
        <label className="relative block">
          <span className="sr-only">Search Assignments</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            inputSize="sm"
            className="pl-9"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, Profile or Gate Policy"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_11rem] gap-4 border-b bg-muted/30 px-5 py-2.5 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-muted-foreground md:grid">
          <span>Assignment</span>
          <span>Quality Profile</span>
          <span>Gate Policy</span>
          <span>Created</span>
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            No Assignment matches this search.
          </p>
        ) : (
          <ul role="list" className="divide-y">
            {shown.map((assignment) => {
              const key = `${assignment.assignment_id}@${assignment.version}`;
              const selected = key === selectedKey;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onSelect(assignment)}
                    className={cn(
                      "grid w-full grid-cols-1 gap-2 px-5 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_11rem] md:items-center md:gap-4",
                      selected && "bg-primary/5",
                    )}
                    aria-current={selected ? "true" : undefined}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{assignment.name}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        v{assignment.version}
                        <Chip size="sm">
                          {assignment.gate_policy_id ? "Release-governed" : "Standardized"}
                        </Chip>
                      </span>
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground" title={assignment.profile_id}>
                      {assignment.profile_id}
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground" title={assignment.gate_policy_id ?? ""}>
                      {assignment.gate_policy_id ?? "None"}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {assignment.created_at ? formatDateTime(assignment.created_at) : "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
        <p className="text-xs text-muted-foreground">
          Without an Assignment the run is diagnostic and never release evidence.
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            Run without an Assignment
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
