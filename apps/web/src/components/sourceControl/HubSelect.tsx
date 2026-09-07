import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
export function HubSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  showLabel = false,
}: {
  label: string;
  showLabel?: boolean;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      {showLabel && <span className="text-xs font-medium text-muted-foreground">{label}</span>}
      <Select
        value={value}
        items={options}
        onValueChange={(value) => {
          const selected = options.find((option) => option.value === value);
          if (selected) onChange(selected.value);
        }}
      >
        <SelectTrigger aria-label={label} className="min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
