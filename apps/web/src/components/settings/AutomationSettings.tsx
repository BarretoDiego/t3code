import type { EnvironmentId, OrchestratorId } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { HooksSettingsSection } from "./automation/HooksSettingsSection";
import { NodesSettingsSection } from "./automation/NodesSettingsSection";
import { OrchestratorsSettingsSection } from "./automation/OrchestratorsSettingsSection";
import { PeersSettingsSection } from "./automation/PeersSettingsSection";
import { automationCapableEnvironments } from "./automationSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Orchestrators, hooks, peers, and nodes with their jobs, per environment.
 * Only environments whose server advertises automation appear: an older
 * server gets no section rather than buttons that would fail.
 */
export function AutomationSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly orchestratorId?: OrchestratorId;
}) {
  const { scope, environments } = useSettingsScope();
  const capable = automationCapableEnvironments(environments);
  if (scope.kind === "unavailable") {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  if (capable.length === 0) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>Automation is not available here</EmptyTitle>
            <EmptyDescription>
              {environments.length === 0
                ? "Connect an environment to manage its orchestrators, hooks, peers and nodes."
                : "The selected environments run a T3 Code server from before automation. Update the server on that machine."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <OrchestratorsSettingsSection environments={capable} target={target} />
      <HooksSettingsSection environments={capable} />
      <PeersSettingsSection environments={capable} />
      <NodesSettingsSection environments={capable} />
    </SettingsPageContainer>
  );
}
