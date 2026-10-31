import { useEffect, useId, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { formatRateLimitResetIn } from "@t3tools/shared/providerRateLimits";
import { create } from "zustand";
import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ScheduleTimeField, localeUses12Hour } from "./ScheduleTimeField";
import {
  type ClockTime,
  type ScheduleWindowOption,
  WINDOW_RESET_BUFFER_MS,
  clockSendAt,
  clockTimeFromIso,
  isSameLocalDay,
  nextClockDay,
  nextFullHour,
  relativeSendAt,
} from "./scheduleSend.logic";

export type ScheduleSendChoice = { readonly sendAt: string | null };

export interface ScheduleSendRequestOptions {
  /** Present when rescheduling a message that already waits. */
  readonly initialSendAt?: string | null;
  /** The selected provider's open limit windows, offered as "when it resets". */
  readonly windows?: ReadonlyArray<ScheduleWindowOption>;
}

type Request = {
  readonly resolve: (choice: ScheduleSendChoice | null) => void;
  readonly initialSendAt: string | null;
  readonly windows: ReadonlyArray<ScheduleWindowOption>;
};

type Mode = "in" | "at" | "window";

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

const WAIT_PRESETS: ReadonlyArray<{ readonly label: string; readonly minutes: number }> = [
  { label: "15 min", minutes: 15 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
];

const TIME_PRESETS: ReadonlyArray<{ readonly label: string; readonly time: ClockTime }> = [
  { label: "Morning", time: { hour: 9, minute: 0 } },
  { label: "Noon", time: { hour: 12, minute: 0 } },
  { label: "Afternoon", time: { hour: 15, minute: 0 } },
  { label: "Evening", time: { hour: 18, minute: 0 } },
];

/**
 * Asks when a queued message should go out. Resolves null on dismiss, and
 * `{ sendAt: null }` when the user removes an existing schedule.
 */
export function requestScheduleSend(
  options: ScheduleSendRequestOptions = {},
): Promise<ScheduleSendChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({
      request: {
        resolve,
        initialSendAt: options.initialSendAt ?? null,
        windows: options.windows ?? [],
      },
    }),
  );
}

function finish(choice: ScheduleSendChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function ScheduleSendDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the pending schedule-send promise with null if the host unmounts while a request is open
  useEffect(() => () => finish(null), []);
  return request ? (
    <ScheduleSendDialog initialSendAt={request.initialSendAt} windows={request.windows} />
  ) : null;
}

interface SchedulePick {
  readonly mode: Mode;
  readonly waitMinutes: number;
  readonly day: Date;
  readonly time: ClockTime;
  readonly selectedWindow: ScheduleWindowOption | null;
}

/** The instant the current picks resolve to, or null while they point at the past. */
function resolveSendAt(pick: SchedulePick, nowMs: number): string | null {
  if (pick.mode === "in") return relativeSendAt({ hours: 0, minutes: pick.waitMinutes }, nowMs);
  if (pick.mode === "at") return clockSendAt(pick.day, pick.time, nowMs);
  const { selectedWindow } = pick;
  return selectedWindow && Date.parse(selectedWindow.sendAt) > nowMs ? selectedWindow.sendAt : null;
}

function describeSendAt(sendAt: string, nowMs: number): string {
  const date = new Date(sendAt);
  const now = new Date(nowMs);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = isSameLocalDay(date, now)
    ? "Today"
    : isSameLocalDay(date, tomorrow)
      ? "Tomorrow"
      : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const wait = formatRateLimitResetIn(sendAt, nowMs);
  return `${day} at ${time}${wait ? ` · in ${wait}` : ""}`;
}

function ScheduleSendDialog({
  initialSendAt,
  windows,
}: {
  initialSendAt: string | null;
  windows: ReadonlyArray<ScheduleWindowOption>;
}) {
  const id = useId();
  const nowMs = useNowMinuteMs();
  const hour12 = localeUses12Hour();
  const initialTime =
    (initialSendAt ? clockTimeFromIso(initialSendAt) : null) ?? nextFullHour(nowMs);
  const [mode, setMode] = useState<Mode>(initialSendAt ? "at" : "in");
  const [waitMinutes, setWaitMinutes] = useState(60);
  const [time, setTime] = useState<ClockTime>(initialTime);
  // `null` follows the time: today while it is still ahead, tomorrow once it has passed.
  const [pickedDay, setPickedDay] = useState<Date | null>(() =>
    initialSendAt ? new Date(initialSendAt) : null,
  );
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [windowId, setWindowId] = useState<string | null>(windows[0]?.id ?? null);

  const day = pickedDay ?? nextClockDay(time, nowMs);
  const todayStart = new Date(nowMs).setHours(0, 0, 0, 0);
  const selectedWindow = windows.find((option) => option.id === windowId) ?? null;

  const pick = { mode, waitMinutes, day, time, selectedWindow };
  const previewSendAt = resolveSendAt(pick, nowMs);

  const hours = Math.floor(waitMinutes / 60);
  const minutes = waitMinutes % 60;
  const setWait = (nextHours: number, nextMinutes: number) =>
    setWaitMinutes(Math.min(30 * 24 * 60, Math.max(0, nextHours * 60 + nextMinutes)));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
            const sendAt = resolveSendAt(pick, Date.now());
            if (sendAt) finish({ sendAt });
          }}
        >
          <DialogHeader>
            <DialogTitle>Schedule send</DialogTitle>
            <DialogDescription>
              The environment holds the message and sends it on its own, even with this window
              closed. Send it now, edit it, move it, or cancel it from the scheduled list.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel layout="stacked">
            <ToggleGroup
              aria-label="When to send"
              className="w-full *:flex-1"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "in" || value === "at" || value === "window") setMode(value);
              }}
            >
              <Toggle value="in">In…</Toggle>
              <Toggle value="at">At…</Toggle>
              {windows.length > 0 ? <Toggle value="window">On reset</Toggle> : null}
            </ToggleGroup>

            {mode === "in" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common waits">
                  {WAIT_PRESETS.map((preset) => (
                    <Button
                      key={preset.minutes}
                      type="button"
                      size="xs"
                      variant={waitMinutes === preset.minutes ? "default" : "outline"}
                      aria-pressed={waitMinutes === preset.minutes}
                      onClick={() => setWaitMinutes(preset.minutes)}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <WaitField
                    label="Hours"
                    value={hours}
                    max={720}
                    onChange={(next) => setWait(next, minutes)}
                  />
                  <WaitField
                    label="Minutes"
                    value={minutes}
                    max={59}
                    step={5}
                    onChange={(next) => setWait(hours, next)}
                  />
                </div>
              </div>
            ) : null}

            {mode === "at" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-day`}>Day</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant={pickedDay === null ? "default" : "outline"}
                      aria-pressed={pickedDay === null}
                      onClick={() => setPickedDay(null)}
                    >
                      Next occurrence
                    </Button>
                    <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                      <PopoverTrigger
                        render={
                          <Button
                            id={`${id}-day`}
                            type="button"
                            size="xs"
                            variant={pickedDay === null ? "outline" : "default"}
                          />
                        }
                      >
                        <CalendarIcon />
                        {day.toLocaleDateString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </PopoverTrigger>
                      <PopoverPopup align="start" aria-label="Choose send date">
                        <Calendar
                          mode="single"
                          required
                          selected={day}
                          defaultMonth={day}
                          disabled={{ before: new Date(todayStart) }}
                          onSelect={(selected) => {
                            setPickedDay(selected);
                            setCalendarOpen(false);
                          }}
                        />
                      </PopoverPopup>
                    </Popover>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Time</Label>
                  <ScheduleTimeField value={time} onChange={setTime} hour12={hour12} />
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common times">
                    {TIME_PRESETS.map((preset) => (
                      <Button
                        key={preset.label}
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setTime(preset.time)}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {mode === "window" ? (
              <div className="flex flex-col gap-2">
                <p className="text-muted-foreground text-xs">
                  Sends {WINDOW_RESET_BUFFER_MS / 60_000} minutes after the window resets, so the
                  new window is open when the message goes out.
                </p>
                <RadioGroup
                  aria-label="Limit window"
                  value={windowId ?? ""}
                  onValueChange={(value) => setWindowId(String(value))}
                >
                  {windows.map((option) => (
                    <Label key={option.id} className="items-start">
                      <Radio value={option.id} className="mt-0.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {option.label}
                          <span className="ms-2 font-normal text-muted-foreground tabular-nums">
                            {Math.round(option.usedPercent)}% used
                          </span>
                        </span>
                        <span className="font-normal text-muted-foreground text-xs">
                          Resets {describeSendAt(option.resetsAt, nowMs)}
                        </span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              </div>
            ) : null}

            <p
              role="status"
              className={previewSendAt ? "text-foreground text-sm" : "text-destructive text-sm"}
            >
              {previewSendAt
                ? `Sends ${describeSendAt(previewSendAt, nowMs)}`
                : mode === "at"
                  ? "That time has passed. Pick a later time or day."
                  : "Choose a time in the future."}
            </p>
          </DialogPanel>
          <DialogFooter>
            {initialSendAt ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                onClick={() => finish({ sendAt: null })}
              >
                Send now instead
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={previewSendAt === null}>
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function WaitField(props: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <NumberField
        aria-label={props.label}
        className="w-32"
        min={0}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onValueChange={(next) => {
          if (next !== null) props.onChange(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Less ${props.label.toLowerCase()}`} />
          <NumberFieldInput />
          <NumberFieldIncrement aria-label={`More ${props.label.toLowerCase()}`} />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}
