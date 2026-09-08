import * as Layer from "effect/Layer";

import { ComputeProviderAdapterRegistry } from "./ComputeProviderAdapter.ts";
import { makeMockComputeProvider } from "./MockComputeProvider.ts";
import { makeManagedComputeProvider } from "./ManagedComputeProvider.ts";
import { makeMockManagedComputeDriver } from "./MockManagedComputeDriver.ts";

export const ComputeProviderAdapterRegistryLive = Layer.sync(ComputeProviderAdapterRegistry, () => {
  const adapters = [
    makeMockComputeProvider(),
    makeManagedComputeProvider(makeMockManagedComputeDriver()),
  ];
  return ComputeProviderAdapterRegistry.of({
    get: (type) => adapters.find((adapter) => adapter.type === type),
    all: adapters,
  });
});
