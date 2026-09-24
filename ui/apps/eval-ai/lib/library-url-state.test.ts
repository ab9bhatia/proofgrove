import { describe, expect, it } from "vitest";

import { readRunLibraryUrlState, writeRunLibrarySearchParams } from "./library-url-state";

describe("library URL state", () => {



  it("round-trips the complete runs filter state", () => {
    const state = {
      query: "nightly",
      label: "release",
      type: "Agent" as const,
      status: "Completed" as const,
      dateMode: "range" as const,
      date: "",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-19",
      lifecycle: "archived" as const,
      page: 2,
      expanded: ["evaluation-a"],
      selectedRunIds: ["run-base", "run-candidate"],
      openRunId: "run-candidate",
      sortKey: "latest_score" as const,
      sortDir: "asc" as const,
    };
    const encoded = writeRunLibrarySearchParams("foo=highlighted", state);

    expect(encoded).toContain("foo=highlighted");
    expect(encoded).toContain("lifecycle=archived");
    expect(encoded).not.toContain("view=archived");
    expect(encoded).toContain("sort=latest_score");
    expect(encoded).toContain("dir=asc");
    expect(readRunLibraryUrlState(new URLSearchParams(encoded))).toEqual(state);
  });

  it("reads legacy view=archived and migrates it to lifecycle on write", () => {
    expect(readRunLibraryUrlState(new URLSearchParams("view=archived"))).toMatchObject({
      lifecycle: "archived",
    });
    const encoded = writeRunLibrarySearchParams("view=archived&tab=experiments", {
      query: "",
      label: "",
      type: "",
      status: "",
      dateMode: "any",
      date: "",
      dateFrom: "",
      dateTo: "",
      lifecycle: "archived",
      page: 1,
      expanded: [],
      selectedRunIds: [],
      openRunId: "",
      sortKey: "last_run",
      sortDir: "desc",
    });
    expect(encoded).toBe("tab=experiments&lifecycle=archived");
  });

  it("clears stale date fields and safely normalizes invalid run parameters", () => {
    const encoded = writeRunLibrarySearchParams(
      "date_mode=range&date_from=2026-08-01&date_to=2026-08-19",
      {
        query: "",
        label: "",
        type: "",
        status: "",
        dateMode: "any",
        date: "",
        dateFrom: "",
        dateTo: "",
        lifecycle: "active",
        page: 1,
        expanded: [],
        selectedRunIds: [],
        openRunId: "",
        sortKey: "last_run",
        sortDir: "desc",
      },
    );
    expect(encoded).toBe("");
    expect(
      readRunLibraryUrlState(
        new URLSearchParams("type=unknown&status=stuck&date_mode=tomorrow&page=-3"),
      ),
    ).toMatchObject({ type: "", status: "", dateMode: "any", page: 1 });
  });

  it("selects runs whose kind comes from the response source", () => {
    // The run label reports the response source ahead of the scenario, so once
    // provided runs stopped answering to `?type=llm` there was no value that
    // reached them at all.
    expect(readRunLibraryUrlState(new URLSearchParams("type=provided"))).toMatchObject({
      type: "Existing responses",
    });
    expect(readRunLibraryUrlState(new URLSearchParams("type=baseline"))).toMatchObject({
      type: "Baseline",
    });
  });

  it("round-trips a two-word run kind through the URL", () => {
    // Lower-casing the label wrote `existing responses`, which reads back as no
    // filter at all — so the selection survived the first render and vanished on
    // the next keystroke, sort or page change that re-serialised the state.
    const state = readRunLibraryUrlState(new URLSearchParams("type=provided"));
    expect(state.type).toBe("Existing responses");
    expect(
      readRunLibraryUrlState(new URLSearchParams(writeRunLibrarySearchParams("", state))),
    ).toMatchObject({
      type: "Existing responses",
    });
  });

  it("round-trips the stopped run filter", () => {
    expect(readRunLibraryUrlState(new URLSearchParams("status=stopped"))).toMatchObject({
      status: "Stopped",
    });
    expect(readRunLibraryUrlState(new URLSearchParams("status=cancelled"))).toMatchObject({
      status: "Stopped",
    });
  });
});

describe("library sort URL state", () => {
  it("defaults to last_run desc and round-trips non-default sorts", () => {
    expect(readRunLibraryUrlState(new URLSearchParams(""))).toMatchObject({
      sortKey: "last_run",
      sortDir: "desc",
    });
    const encoded = writeRunLibrarySearchParams("", {
      query: "",
      label: "",
      type: "",
      status: "",
      dateMode: "any",
      date: "",
      dateFrom: "",
      dateTo: "",
      lifecycle: "active",
      page: 1,
      expanded: [],
      selectedRunIds: [],
      openRunId: "",
      sortKey: "runs",
      sortDir: "asc",
    });
    expect(encoded).toBe("sort=runs&dir=asc");
    expect(readRunLibraryUrlState(new URLSearchParams(encoded))).toMatchObject({
      sortKey: "runs",
      sortDir: "asc",
    });
  });
});
