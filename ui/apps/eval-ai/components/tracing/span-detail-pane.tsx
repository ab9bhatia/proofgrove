"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ErrorState, LoadingState } from "@/components/page-state";
import {
  buildLlmSpanDetail,
  formatLlmCostSummary,
  formatLlmTokenSummary,
  isLlmSpan,
  llmSpanCost,
  llmSpanModel,
  type LlmCostBreakdown,
  type LlmInvocationParam,
  type LlmMessage,
  type LlmMessageTab,
  type LlmTokenCounts,
} from "@/components/tracing/llm-span-detail";
import { spanContentExtraction, type SpanContentCard } from "@/components/tracing/span-content";
import { KindChip, SpanKindIcon } from "@/components/tracing/span-tree-pane";
import { spanKindChip } from "@/components/tracing/span-tree";
import { Datum, MetadataBand } from "@/components/tracing/trace-facts";
import { spanMetadataFields } from "@/components/tracing/trace-metadata";
import { formatSpanStartTime, spanTokenCount } from "@/components/tracing/trace-workspace";
import type { ArchivedTraceSpan } from "@/lib/api";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@evalai/shared/utils";


interface DetailTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Content-card attribute keys shown beside the input/output message sub-tabs. */
const INPUT_CARD_KEYS = ["input.value", "gen_ai.prompt"] as const;
const OUTPUT_CARD_KEYS = ["output.value", "gen_ai.completion"] as const;
export function SpanDetailPane({
  loading,
  error,
  onRetry,
  span,
  emptyMessage,
  scrollClassName,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  span: ArchivedTraceSpan | null;
  emptyMessage: string;
  scrollClassName: string;
}) {
  const [tab, setTab] = useState<string>("info");
  const llmDetail = useMemo(
    () => (span && isLlmSpan(span) ? buildLlmSpanDetail(span) : null),
    [span],
  );
  const content = useMemo(
    () => (span ? spanContentExtraction(span.attributes) : null),
    [span],
  );

  if (error) {
    return (
      <div className="p-4">
        <ErrorState title="Span detail unavailable" message={error} onRetry={onRetry} />
      </div>
    );
  }
  if (loading) return <LoadingState label="Loading span…" className="min-h-40" />;
  if (!span) {
    return (
      <p className="p-4 text-sm leading-6 text-muted-foreground">{emptyMessage}</p>
    );
  }

  const metadata = spanMetadataFields(span);
  const cards = content?.cards ?? [];
  const cardByKey = new Map(cards.map((card) => [card.key, card]));

  const facts = (
    <>
      {llmDetail ? (
        <LlmUsageBand
          tokenCounts={llmDetail.tokenCounts}
          cost={llmDetail.cost}
          estimatedCostUsd={span.estimated_cost_usd}
        />
      ) : (
        <EstimatedCostLine usd={span.estimated_cost_usd} />
      )}
    </>
  );

  const info = llmDetail ? (
    <>
      {facts}
      <LlmMessagePanel
        key={`${span.span_id}-input`}
        ariaLabel="LLM input"
        title="Input"
        idPrefix="span-llm-input"
        tabs={[
          ...messageSubTabs(llmDetail.messageTabs, "input"),
          ...cardSubTabs(cardByKey, INPUT_CARD_KEYS),

        ]}
      />
      <LlmMessagePanel
        key={`${span.span_id}-output`}
        ariaLabel="LLM output"
        title="Output"
        idPrefix="span-llm-output"
        tabs={[
          ...messageSubTabs(llmDetail.messageTabs, "output"),
          ...cardSubTabs(cardByKey, OUTPUT_CARD_KEYS),
        ]}
      />
      {!llmDetail.messageTabs.length && !cards.length ? <p className="mt-4 text-sm text-muted-foreground">No readable input or output was captured. Inspect Attributes for the recorded payload.</p> : null}
      {llmDetail.invocationParams.length ? <details className="mt-4"><summary className="cursor-pointer py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">Model settings</summary><InvocationParamsList params={llmDetail.invocationParams.filter(param => !param.key.startsWith("gcp.") && param.key !== "gen_ai.system" && param.key !== "gen_ai.operation.name")} /></details> : null}
    </>
  ) : (
    <>
      {facts}
      {cards.map((card) => (
        <ContentCard key={card.key} label={card.label} text={card.text} />
      ))}
      {!cards.length ? <p className="mt-4 text-sm text-muted-foreground">No readable input or output was captured. Inspect Attributes and Events for the recorded details.</p> : null}
    </>
  );

  const attributes = (
    <>
      {metadata.length ? <MetadataBand fields={metadata} className="mt-4" /> : null}
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs"><Datum label="Span ID" value={span.span_id} /><Datum label="Parent span" value={span.parent_span_id || "Root span"} /><Datum label="Type source" value={span.semantic_kind_source === "telemetry_compatibility" ? "Telemetry compatibility" : span.semantic_kind_source || "Not recorded"} /></dl>
      <AttributeView key={span.span_id} attributes={span.attributes ?? {}} />
      {span.status ? <Payload label="Status" value={span.status} /> : null}
      {Object.keys(span.resource_attributes ?? {}).length ? <Payload label="Resource attributes" value={span.resource_attributes} /> : null}
    </>
  );

  const tabs: DetailTab[] = [
    { id: "info", label: "Info", content: info },
    { id: "attributes", label: "Attributes", content: attributes },
    { id: "events", label: `Events ${span.events.length}`, content: <SpanEvents events={span.events} /> },
  ];
  const active = tabs.some((candidate) => candidate.id === tab) ? tab : "info";

  return (
    <div className={cn("p-4", scrollClassName)}>
      <SpanHeader span={span} />
      <TabGroup
        label="Span detail sections"
        idPrefix="span-detail"
        tabs={tabs}
        active={active}
        onSelect={setTab}
        variant="underline"
        listClassName="mt-4"
      />
    </div>
  );
}
function SpanHeader({ span }: { span: ArchivedTraceSpan }) {
  const kind = spanKindChip(span);
  const duration = formatDuration(span.duration_ms);
  const startedAt = formatSpanStartTime(span.start_time_unix_nano);
  const tokens = spanTokenCount(span);
  const model = llmSpanModel(span.attributes);
  const recordedCost = llmSpanCost(span.attributes);
  const cost = recordedCost ?? formatUsd(span.estimated_cost_usd ?? null);

  return (
    <header>
      <div className="flex flex-wrap items-center gap-2">
        {kind ? <SpanKindIcon label={kind.label} /> : null}
        <h4 title={span.name} className="min-w-0 break-all text-sm font-semibold">
          {span.name}
        </h4>
        {kind ? <KindChip label={kind.label} tone={kind.tone} /> : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {model ? <span>{model}</span> : null}
        {duration ? <span className="tabular-nums">{duration}</span> : null}
        {startedAt ? <span>at {startedAt}</span> : null}
        {tokens != null ? <span className="tabular-nums">{tokens} tokens</span> : null}
        {cost ? <span className="tabular-nums">Cost {cost}</span> : null}
      </div>
    </header>
  );
}

function EstimatedCostLine({ usd }: { usd: number | null | undefined }) {
  const formatted = formatUsd(usd ?? null);
  if (!formatted) return null;
  return (
    <p className="mt-3 font-mono text-xs leading-5 text-muted-foreground">
      Estimated cost: {formatted}
    </p>
  );
}

function messageSubTabs(
  tabs: ReadonlyArray<LlmMessageTab>,
  id: LlmMessageTab["id"],
): DetailTab[] {
  const tab = tabs.find((candidate) => candidate.id === id);
  if (!tab) return [];
  return [
    {
      id: `${id}-messages`,
      label: tab.label,
      content: <MessageList messages={tab.messages} />,
    },
  ];
}

function cardSubTabs(
  cardByKey: ReadonlyMap<string, SpanContentCard>,
  keys: ReadonlyArray<string>,
): DetailTab[] {
  return keys.flatMap((key) => {
    const card = cardByKey.get(key);
    if (!card) return [];
    return [
      {
        id: card.key,
        label: card.label,
        content: <ContentCard label={card.label} text={card.text} embedded />,
      },
    ];
  });
}

function LlmMessagePanel({
  ariaLabel,
  title,
  idPrefix,
  tabs,
}: {
  ariaLabel: string;
  title: string | null;
  idPrefix: string;
  tabs: ReadonlyArray<DetailTab>;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  if (tabs.length === 0) return null;
  const current = tabs.some((tab) => tab.id === active) ? active : tabs[0]!.id;

  return (
    <section className="mt-4 rounded-lg border" aria-label={ariaLabel}>
      {title ? <h5 className="border-b px-3 py-2 text-sm font-medium">{title}</h5> : null}
      {tabs.length === 1 ? tabs[0].content : <TabGroup
        label={`${ariaLabel} sections`}
        idPrefix={idPrefix}
        tabs={tabs}
        active={current}
        onSelect={setActive}
        variant="pill"
        listClassName="m-2"
      />}
    </section>
  );
}

/**
 * One tablist implementation for both levels of this pane, backed by the
 * shared primitive. It replaces a hand-rolled tablist that duplicated the
 * roving-tabindex keyboard contract the primitive already owns, and it means
 * the span sections now read in the same visual language as the Traces / Spans
 * strip at the top of the project.
 *
 * Inactive panels stay mounted behind `hidden` (the canonical ARIA tabs shape):
 * find-in-page still reaches the attributes and events of the selected span
 * without the operator hunting through tabs first.
 */
function TabGroup({
  label,
  idPrefix,
  tabs,
  active,
  onSelect,
  variant,
  listClassName,
}: {
  label: string;
  idPrefix: string;
  tabs: ReadonlyArray<DetailTab>;
  active: string;
  onSelect: (id: string) => void;
  variant: "pill" | "underline";
  listClassName?: string;
}) {
  return (
    <Tabs value={active} onValueChange={onSelect} variant={variant}>
      <TabsList aria-label={label} className={listClassName}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsPanel
          key={tab.id}
          id={`${idPrefix}-panel-${tab.id}`}
          aria-labelledby={`${idPrefix}-tab-${tab.id}`}
          hidden={tab.id !== active}
        >
          {tab.content}
        </TabsPanel>
      ))}
    </Tabs>
  );
}

function MessageList({ messages }: { messages: ReadonlyArray<LlmMessage> }) {
  if (messages.length === 0) {
    return (
      <p className="p-3 text-sm leading-6 text-muted-foreground">No messages were recorded.</p>
    );
  }
  return (
    <div className="space-y-2 p-3">
      {messages.map((message, index) => (
        <details key={index} open={message.role !== "system"} className="border-b last:border-b-0">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {message.role ?? "message"}
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-sans text-sm leading-6">
            {message.content}
          </pre>
        </details>
      ))}
    </div>
  );
}

function SpanEvents({ events }: { events: ReadonlyArray<Record<string, unknown>> }) {
  if (events.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed px-3 py-6 text-sm leading-6 text-muted-foreground">
        No events were recorded on this span.
      </p>
    );
  }
  return (
    <ul className="mt-4 space-y-2">
      {events.map((event, index) => (
        <li key={index} className="rounded-lg border">
          <p className="border-b px-3 py-2 text-sm font-medium">
            {typeof event.name === "string" && event.name.trim() ? event.name : `Event ${index + 1}`}
          </p>
          {typeof (event.timeUnixNano ?? event.time_unix_nano) === "string" ? <p className="px-3 pt-2 text-xs text-muted-foreground">{formatSpanStartTime(String(event.timeUnixNano ?? event.time_unix_nano))}</p> : null}
          {typeof event.attributes === "object" && event.attributes !== null && "exception.message" in event.attributes ? <p className="whitespace-pre-wrap break-words px-3 pt-2 text-sm text-destructive">{String(event.attributes["exception.message"])}</p> : null}
          <details className="px-3 pb-3"><summary className="cursor-pointer py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring">Event details</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{JSON.stringify(event, null, 2)}</pre></details>
        </li>
      ))}
    </ul>
  );
}

function InvocationParamsList({ params }: { params: ReadonlyArray<LlmInvocationParam> }) {
  return (
    <dl className="grid gap-2 p-3 text-xs sm:grid-cols-2">
      {params.map((param) => (
        <div key={param.key} className="min-w-0">
          <dt className="text-muted-foreground">{param.key}</dt>
          <dd className="mt-1 break-all font-mono text-sm">{param.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ContentCard({ label, text, embedded = false }: { label: string; text: string; embedded?: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context): leave the text
      // selectable rather than pretending the copy happened.
    }
  };

  return (
    <section
      className={cn(!embedded && "mt-4 rounded-lg border")}
      aria-label={label}
    >
      <div className={cn("flex items-center justify-between gap-2 px-3 py-2", !embedded && "border-b")}>
        <h5 className="text-sm font-medium">{label}</h5>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{text}</pre>
    </section>
  );
}
function LlmUsageBand({
  tokenCounts,
  cost,
  estimatedCostUsd,
}: {
  tokenCounts: LlmTokenCounts;
  cost: LlmCostBreakdown;
  estimatedCostUsd?: number | null;
}) {
  const tokenSummary = formatLlmTokenSummary(tokenCounts);
  const estimated = formatUsd(estimatedCostUsd ?? null);
  const costSummary = formatLlmCostSummary(cost) ?? (estimated ? `estimated ${estimated}` : null);
  if (!tokenSummary && !costSummary) return null;

  return (
    // Token and cost are two facts about the span, not a third surface. They
    // were a tinted purple card sitting inside the detail card.
    <section aria-label="Token and cost usage" className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {tokenSummary ? (
        <p className="font-mono text-sm font-medium leading-6 text-foreground">{tokenSummary}</p>
      ) : null}

    </section>
  );
}
function AttributeView({ attributes }: { attributes: Record<string, unknown> }) {
  const [query, setQuery] = useState("");
  const [json, setJson] = useState(false);
  const [limit, setLimit] = useState(100);
  const entries = Object.entries(attributes);
  const filtered = entries.filter(([key, value]) => `${key} ${JSON.stringify(value)}`.toLowerCase().includes(query.toLowerCase()));
  return <section aria-label="Span attributes" className="mt-4 min-w-0">
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <input type="search" aria-label="Search attributes" placeholder="Search attributes" value={query} onChange={event => { setQuery(event.target.value); setLimit(100); }} className="min-h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <div role="group" aria-label="Attribute view" className="flex gap-1">
        <button type="button" aria-pressed={!json} onClick={() => setJson(false)} className="min-h-9 rounded-md border px-3 text-sm aria-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring">Table</button>
        <button type="button" aria-pressed={json} onClick={() => setJson(true)} className="min-h-9 rounded-md border px-3 text-sm aria-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring">JSON</button>
      </div>
    </div>
    <p className="mb-2 text-xs text-muted-foreground">{filtered.length} of {entries.length} attributes</p>
    {!filtered.length ? <p className="py-4 text-sm text-muted-foreground">{entries.length ? "No matching attributes." : "No attributes recorded."}</p> : json
      ? <ContentCard label={query ? "Matching attributes" : "All attributes"} text={JSON.stringify(Object.fromEntries(filtered), null, 2)} embedded />
      : <><table className="w-full table-fixed text-sm" aria-label="Span attributes"><thead><tr className="border-b text-left"><th className="w-2/5 py-2 pr-3 font-medium">Attribute</th><th className="py-2 font-medium">Value</th></tr></thead><tbody>{filtered.slice(0, limit).map(([key, value]) => <tr key={key} className="border-b align-top"><th scope="row" className="break-words py-3 pr-3 text-left font-normal text-muted-foreground">{key}</th><td className="py-3"><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></td></tr>)}</tbody></table>{filtered.length > limit ? <button type="button" className="mt-3 min-h-9 rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setLimit(value => value + 100)}>Show more attributes</button> : null}</>}
  </section>;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="mt-4 rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </summary>
      <pre className="max-h-80 overflow-auto border-t p-3 text-xs leading-5">{JSON.stringify(value ?? "Not recorded", null, 2)}</pre>
    </details>
  );
}
