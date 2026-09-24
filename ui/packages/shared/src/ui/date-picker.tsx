"use client";

import * as React from "react";
import {
  CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  X,
} from "lucide-react";
import { DayPicker } from "react-day-picker";
import { format } from "date-fns";
import { cn } from "@evalai/shared/utils";
import { parseIsoDate, toIsoDate } from "@evalai/shared/date-utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@evalai/shared/ui/popover";

export interface DatePickerProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  minDate?: string;
  maxDate?: string;
  id?: string;
  name?: string;
  className?: string;
  "aria-invalid"?: boolean;
}

function Chevron({
  orientation,
  className,
}: {
  orientation?: "up" | "down" | "left" | "right";
  className?: string;
}) {
  const Cmp =
    orientation === "left"
      ? ChevronLeft
      : orientation === "right"
        ? ChevronRight
        : orientation === "up"
          ? ChevronUp
          : ChevronDown;
  return <Cmp className={cn("h-4 w-4", className)} />;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "mm/dd/yyyy",
  disabled,
  clearable = false,
  minDate,
  maxDate,
  id,
  name,
  className,
  "aria-invalid": ariaInvalid,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseIsoDate(value);
  const [month, setMonth] = React.useState<Date>(
    () => selected ?? parseIsoDate(minDate) ?? new Date(),
  );
  const disabledDays = React.useMemo(() => {
    const matchers = [];
    const min = parseIsoDate(minDate);
    if (min) matchers.push({ before: min });
    const max = parseIsoDate(maxDate);
    if (max) matchers.push({ after: max });
    return matchers.length > 0 ? matchers : undefined;
  }, [minDate, maxDate]);

  function clearValue() {
    onChange?.("");
  }

  function clearAndClose() {
    clearValue();
    setOpen(false);
  }

  function openCalendar() {
    setMonth(selected ?? parseIsoDate(minDate) ?? new Date());
    setOpen(true);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        if (next) {
          setMonth(selected ?? parseIsoDate(minDate) ?? new Date());
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <div
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-invalid={ariaInvalid}
          aria-disabled={disabled || undefined}
          tabIndex={disabled ? -1 : 0}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openCalendar();
            }
          }}
          className={cn(
            "flex h-[60px] w-full items-center gap-2 rounded-[12px] border-2 border-[rgba(41,41,41,0.24)] bg-background pl-4 pr-2 text-left",
            "text-base font-medium text-foreground",
            "focus:outline-none focus-visible:border-foreground",
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:pointer-events-none",
            "aria-invalid:border-destructive",
            className,
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? format(selected, "MM/dd/yyyy") : placeholder}
          </span>
          {clearable && selected && !disabled && (
            <button
              type="button"
              aria-label="Clear date"
              onPointerDown={(event) => {
                // Keep Radix trigger from toggling the popover when clearing.
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearAndClose();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                }
                event.stopPropagation();
              }}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[rgba(41,41,41,0.08)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgba(41,41,41,0.16)]">
            <CalendarIcon className="h-5 w-5" />
          </span>
          {name ? <input type="hidden" name={name} value={value ?? ""} readOnly /> : null}
        </div>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <DayPicker
          mode="single"
          weekStartsOn={1}
          showOutsideDays
          month={month}
          onMonthChange={setMonth}
          selected={selected}
          disabled={disabledDays}
          onSelect={(date) => {
            if (date) {
              onChange?.(toIsoDate(date));
              setMonth(date);
              setOpen(false);
              return;
            }
            if (clearable) {
              clearValue();
              setOpen(false);
            }
          }}
          components={{ Chevron }}
          classNames={{
            months: "flex flex-col",
            month: "flex flex-col gap-3",
            month_caption: "flex items-center px-1 pb-1",
            caption_label: "text-base font-medium",
            nav: "absolute right-1 top-1 flex items-center gap-1",
            button_previous:
              "h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-[rgba(41,41,41,0.08)]",
            button_next:
              "h-8 w-8 inline-flex items-center justify-center rounded-full hover:bg-[rgba(41,41,41,0.08)]",
            month_grid: "w-full border-collapse",
            weekdays: "flex",
            weekday:
              "w-9 text-center text-xs font-medium text-muted-foreground",
            week: "flex w-full mt-1",
            day: "h-9 w-9 text-center text-sm p-0 relative data-[selected=true]:[&>button]:bg-foreground data-[selected=true]:[&>button]:text-background data-[selected=true]:[&>button]:hover:bg-foreground",
            day_button:
              "h-9 w-9 inline-flex items-center justify-center rounded-full text-sm font-medium hover:bg-[rgba(41,41,41,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground",
            selected: "",
            today: "[&>button]:underline",
            outside: "[&>button]:text-muted-foreground/40",
            disabled:
              "[&>button]:text-muted-foreground/30 [&>button]:cursor-not-allowed",
          }}
        />
        {clearable && selected && (
          <button
            type="button"
            onClick={() => {
              clearAndClose();
            }}
            className="mt-3 w-full rounded-lg border border-input px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-[rgba(41,41,41,0.08)]"
          >
            Clear date
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
