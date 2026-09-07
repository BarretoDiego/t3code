import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
export function HubSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
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
  );
}
