import { useEffect, useId, useState } from "react";
import { CalendarIcon } from "lucide-react";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
} from "@t3tools/client-runtime/state/thread-settled";
import { create } from "zustand";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export type ScheduleSendChoice = { readonly sendAt: string | null };

type Request = {
  readonly resolve: (choice: ScheduleSendChoice | null) => void;
  /** Present when rescheduling a message that already waits. */
  readonly initialSendAt: string | null;
};

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

const PRESETS: ReadonlyArray<{ readonly label: string; readonly minutes: number }> = [
  { label: "In 5 minutes", minutes: 5 },
  { label: "In 15 minutes", minutes: 15 },
  { label: "In 30 minutes", minutes: 30 },
  { label: "In 1 hour", minutes: 60 },
];

/**
 * Asks when a queued message should go out. Presets resolve immediately; the
 * custom date/time resolves on submit. Resolves null on dismiss, and
 * `{ sendAt: null }` when the user removes an existing schedule.
 */
export function requestScheduleSend(initialSendAt: string | null = null): Promise<ScheduleSendChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) =>
    useRequest.setState({ request: { resolve, initialSendAt } }),
  );
}

function finish(choice: ScheduleSendChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function ScheduleSendDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ScheduleSendDialog initialSendAt={request.initialSendAt} /> : null;
}

function ScheduleSendDialog({ initialSendAt }: { initialSendAt: string | null }) {
  const id = useId();
  const [initial] = useState(() => {
    const base = initialSendAt ? Date.parse(initialSendAt) : Number.NaN;
    return new Date(Number.isFinite(base) ? base : Date.now() + 3_600_000);
  });
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const sendAt = resolveCustomSnooze(
              { mode: "date", date: localSnoozeDate(date), time },
              new Date(),
            );
            if (!sendAt) {
              setError("Choose a valid date and time in the future.");
              return;
            }
            finish({ sendAt });
          }}
        >
          <DialogHeader>
            <DialogTitle>Schedule send</DialogTitle>
            <DialogDescription>
              The message waits in the queue and goes out on its own. Send now still forces it,
              Cancel still drops it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4 text-base sm:text-sm">
            <div className="flex flex-col gap-1" role="group" aria-label="Quick times">
              {PRESETS.map((preset) => (
                <Button
                  key={preset.minutes}
                  type="button"
                  variant="ghost"
                  className="justify-start font-normal"
                  onClick={() =>
                    finish({ sendAt: new Date(Date.now() + preset.minutes * 60_000).toISOString() })
                  }
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-date`}>Date</Label>
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        id={`${id}-date`}
                        variant="outline"
                        className="w-full justify-between font-normal"
                      />
                    }
                  >
                    {date.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    <CalendarIcon className="size-4 text-muted-foreground" />
                  </PopoverTrigger>
                  <PopoverPopup align="start" aria-label="Choose send date">
                    <Calendar
                      mode="single"
                      required
                      selected={date}
                      defaultMonth={date}
                      disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                      onSelect={(selected) => {
                        setDate(selected);
                        setCalendarOpen(false);
                        setError(null);
                      }}
                    />
                  </PopoverPopup>
                </Popover>
              </div>
              <Label
                className="flex min-w-0 flex-col items-stretch gap-1.5"
                htmlFor={`${id}-time`}
              >
                Time
                <Input
                  nativeInput
                  id={`${id}-time`}
                  className="h-9 sm:h-8"
                  type="time"
                  required
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value);
                    setError(null);
                  }}
                />
              </Label>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {initialSendAt ? (
              <Button
                type="button"
                variant="ghost"
                className="mr-auto"
                onClick={() => finish({ sendAt: null })}
              >
                Remove schedule
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Schedule</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
