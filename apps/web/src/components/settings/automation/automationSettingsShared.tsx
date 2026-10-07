import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type { ReactNode } from "react";

import type { EnvironmentPresentation } from "../../../state/environments";
import type { EnvironmentQueryView } from "../../../state/query";
import { EnvironmentMachineIcon } from "../../EnvironmentMachineIcon";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import { automationEnvironmentAvailability } from "../automationSettings.logic";
import { SettingsRow, SettingsSection } from "../settingsLayout";

/** A caption above its control, with an optional hint on the right. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="text-right font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

/** A JSON field. What it holds is checked against the contract when the form is saved. */
export function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Textarea
        id={id}
        variant="code"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** What stopped a save: the form's own checks, or the server's answer. */
export function DraftErrors({ errors }: { readonly errors: ReadonlyArray<string> }) {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="m-0 list-none space-y-1 p-0 text-sm text-destructive">
      {errors.map((error) => (
        <li key={error} className="whitespace-pre-wrap">
          {error}
        </li>
      ))}
    </ul>
  );
}

/**
 * One environment's block inside an automation section. An environment that is
 * not connected keeps its heading and says why its list is missing: the
 * automation there keeps running without this client.
 */
export function AutomationEnvironmentSection({
  environment,
  showHeading,
  noun,
  children,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showHeading: boolean;
  readonly noun: string;
  readonly children: ReactNode;
}) {
  const ready = automationEnvironmentAvailability(environment) === "ready";
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {ready ? (
        children
      ) : (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to see its ${noun}. They keep working there without this app.`}
        />
      )}
    </SettingsSection>
  );
}

/** Loading, error and empty rows for a list, then the list itself. */
export function QueryRows<A>({
  query,
  noun,
  isEmpty,
  emptyDescription,
  children,
}: {
  readonly query: EnvironmentQueryView<A>;
  readonly noun: string;
  readonly isEmpty: (data: A) => boolean;
  readonly emptyDescription: string;
  readonly children: (data: A) => ReactNode;
}) {
  if (query.data === null) {
    return query.error !== null ? (
      <SettingsRow title={`Could not load ${noun}`} description={query.error} />
    ) : (
      <SettingsRow title={`Loading ${noun}…`} role="status" />
    );
  }
  return (
    <>
      {query.error !== null ? (
        <SettingsRow
          title={`Could not refresh ${noun}`}
          description={`${query.error} Showing the last list that loaded.`}
          role="status"
        />
      ) : null}
      {isEmpty(query.data) ? (
        <SettingsRow title={`No ${noun}`} description={emptyDescription} />
      ) : (
        children(query.data)
      )}
    </>
  );
}
