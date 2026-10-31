import { cn } from "~/lib/utils";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { type ClockTime, from12Hour, to12Hour } from "./scheduleSend.logic";

const TWO_DIGITS: Intl.NumberFormatOptions = { minimumIntegerDigits: 2, maximumFractionDigits: 0 };

/** Whether this locale shows an AM/PM clock. */
export function localeUses12Hour(): boolean {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;
}

function StepField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onChange: (value: number) => void;
}) {
  const { min, max } = props;
  return (
    <NumberField
      aria-label={props.label}
      className="w-28"
      format={TWO_DIGITS}
      min={min - 1}
      max={max + 1}
      step={props.step ?? 1}
      value={props.value}
      onValueChange={(next) => {
        if (next === null) return;
        // One step past either end wraps around, like a clock; a typed value just clamps.
        if (next > max) props.onChange(next === max + 1 ? min : max);
        else if (next < min) props.onChange(next === min - 1 ? max : min);
        else props.onChange(next);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Earlier ${props.label.toLowerCase()}`} />
        <NumberFieldInput />
        <NumberFieldIncrement aria-label={`Later ${props.label.toLowerCase()}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

/**
 * Hour and minute steppers that wrap around the clock. Each field is typeable,
 * so a known time is faster to enter than to scroll to.
 */
export function ScheduleTimeField(props: {
  readonly value: ClockTime;
  readonly onChange: (value: ClockTime) => void;
  readonly hour12: boolean;
  readonly className?: string;
}) {
  const { value, onChange, hour12 } = props;
  const twelve = to12Hour(value.hour);
  return (
    <div className={cn("flex flex-wrap items-center gap-2", props.className)}>
      {hour12 ? (
        <StepField
          label="Hour"
          value={twelve.hour}
          min={1}
          max={12}
          onChange={(hour) => onChange({ ...value, hour: from12Hour(hour, twelve.pm) })}
        />
      ) : (
        <StepField
          label="Hour"
          value={value.hour}
          min={0}
          max={23}
          onChange={(hour) => onChange({ ...value, hour })}
        />
      )}
      <span aria-hidden className="text-muted-foreground">
        :
      </span>
      <StepField
        label="Minute"
        value={value.minute}
        min={0}
        max={59}
        step={5}
        onChange={(minute) => onChange({ ...value, minute })}
      />
      {hour12 ? (
        <ToggleGroup
          aria-label="AM or PM"
          value={[twelve.pm ? "pm" : "am"]}
          onValueChange={(next) => {
            const period = next[0];
            if (period === undefined) return;
            onChange({ ...value, hour: from12Hour(twelve.hour, period === "pm") });
          }}
        >
          <Toggle value="am">AM</Toggle>
          <Toggle value="pm">PM</Toggle>
        </ToggleGroup>
      ) : null}
    </div>
  );
}
