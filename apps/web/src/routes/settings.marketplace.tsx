import { createFileRoute } from "@tanstack/react-router";

import { MarketplaceSettings } from "../components/settings/MarketplaceSettings";

function SettingsMarketplaceRoute() {
  return <MarketplaceSettings />;
}

export const Route = createFileRoute("/settings/marketplace")({
  component: SettingsMarketplaceRoute,
});
