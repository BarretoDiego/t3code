import { EnvironmentId, HookDeliveryStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationCapableEnvironments,
  automationEnvironmentAvailability,
  HOOK_DELIVERY_FILTERS,
  hookDeliveryActions,
  hookDeliveryFilterStatuses,
  tailLogText,
  validateAutomationSettingsSearch,
} from "./automationSettings.logic";
import { filterAvailableSettingsSearchItems } from "./settingsSearch";

function environment(id: string, phase: string, automation: boolean | undefined | null) {
  return {
    environmentId: EnvironmentId.make(id),
    connection: { phase },
    serverConfig:
      automation === null
        ? null
        : {
            environment: {
              capabilities: automation === undefined ? {} : { automation },
            },
          },
  };
}

describe("automation capability gating", () => {
  it("shows an environment only when its server advertises automation", () => {
    expect(automationEnvironmentAvailability(environment("a", "connected", true))).toBe("ready");
    // A server from before automation omits the capability.
    expect(automationEnvironmentAvailability(environment("b", "connected", undefined))).toBe(
      "unsupported",
    );
    expect(automationEnvironmentAvailability(environment("c", "connected", false))).toBe(
      "unsupported",
    );
    // No descriptor yet: nothing says it supports automation.
    expect(automationEnvironmentAvailability(environment("d", "connected", null))).toBe(
      "unsupported",
    );
  });

  it("keeps a capable environment that is not connected, marked as such", () => {
    for (const phase of ["connecting", "backoff", "offline", "available", "blocked"]) {
      expect(automationEnvironmentAvailability(environment("a", phase, true)), phase).toBe(
        "disconnected",
      );
    }
  });

  it("drops only the unsupported environments from the page", () => {
    const capable = automationCapableEnvironments([
      environment("new", "connected", true),
      environment("old", "connected", undefined),
      environment("away", "offline", true),
    ]);
    expect(capable.map((entry) => entry.environmentId)).toEqual(["new", "away"]);
    expect(automationCapableEnvironments([])).toEqual([]);
  });

  it("hides the automation search entries until an environment supports it", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const automationIds = (items: ReturnType<typeof filterAvailableSettingsSearchItems>) =>
      items.filter((item) => item.to === "/settings/automation").map((item) => item.id);
    expect(automationIds(filterAvailableSettingsSearchItems(availability))).toEqual([]);
    expect(
      automationIds(filterAvailableSettingsSearchItems({ ...availability, hasAutomation: false })),
    ).toEqual([]);
    expect(
      automationIds(filterAvailableSettingsSearchItems({ ...availability, hasAutomation: true })),
    ).toEqual([
      "automation-orchestrators",
      "automation-hooks",
      "automation-peers",
      "automation-nodes",
    ]);
  });
});

describe("validateAutomationSettingsSearch", () => {
  it("keeps a deep link's environment and orchestrator and drops blanks", () => {
    expect(
      validateAutomationSettingsSearch({ environmentId: "laptop", orchestratorId: "main" }),
    ).toEqual({ environmentId: "laptop", orchestratorId: "main" });
    expect(
      validateAutomationSettingsSearch({ environmentId: " ", orchestratorId: 7, other: "x" }),
    ).toEqual({});
  });
});

describe("hook deliveries", () => {
  it("covers every delivery status with a filter, and All with none", () => {
    const filtered = HOOK_DELIVERY_FILTERS.flatMap((filter) => filter.statuses ?? []);
    expect([...filtered].toSorted()).toEqual([...HookDeliveryStatus.literals].toSorted());
    expect(hookDeliveryFilterStatuses("all")).toBeNull();
    expect(hookDeliveryFilterStatuses("attention")).toEqual(["failed", "suppressed", "retrying"]);
  });

  it("offers redelivery and dismissal only where they apply", () => {
    expect(hookDeliveryActions("failed")).toEqual({ canRedeliver: true, canDismiss: true });
    expect(hookDeliveryActions("suppressed")).toEqual({ canRedeliver: true, canDismiss: true });
    expect(hookDeliveryActions("retrying")).toEqual({ canRedeliver: false, canDismiss: true });
    for (const status of ["pending", "delivering", "delivered", "status_from_a_newer_server"]) {
      expect(hookDeliveryActions(status), status).toEqual({
        canRedeliver: false,
        canDismiss: false,
      });
    }
  });
});

describe("tailLogText", () => {
  it("keeps the last lines whole", () => {
    expect(tailLogText("one\ntwo\nthree\n", 2)).toBe("two\nthree");
    expect(tailLogText("one\ntwo", 5)).toBe("one\ntwo");
    expect(tailLogText("", 5)).toBe("");
    expect(tailLogText("only\n", 1)).toBe("only");
  });
});
