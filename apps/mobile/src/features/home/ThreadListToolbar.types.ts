import type { MenuAction } from "@react-native-menu/menu";

export interface ThreadListToolbarProps {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly filterActions: MenuAction[];
  readonly filterCustomized: boolean;
  readonly onFilterSelect: (id: string) => void;
  readonly onOpenEnvironments: () => void;
  /** Fork-specific operations dashboard, retained alongside the Material toolbar. */
  readonly onOpenAgentBoard?: () => void;
  readonly onRequestVisibility?: () => void;
}
