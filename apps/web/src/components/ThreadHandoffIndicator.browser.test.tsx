import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, ThreadHandoffRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type HandoffResult = AsyncResult.AsyncResult<ThreadHandoffRecord | null, Error>;
const decodeHandoffRecord = Schema.decodeSync(ThreadHandoffRecord);
const state = vi.hoisted(() => ({
  handoffs: new Map<string, Atom.Writable<HandoffResult>>(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcSubscriptionAtomFamily:
    () =>
    ({ input }: { input: { threadId: string } }) =>
      state.handoffs.get(input.threadId)!,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "source",
        label: "My computer",
        serverConfig: { environment: { capabilities: { threadHandoff: true } } },
      },
      { environmentId: "destination", label: "Remote computer" },
    ],
  }),
}));

import { ThreadHandoffIndicator } from "./ThreadHandoffIndicator";
import { TooltipProvider } from "./ui/tooltip";

function setup() {
  const registry = AtomRegistry.make();
  for (const id of ["first", "second"]) {
    state.handoffs.set(id, Atom.make<HandoffResult>(AsyncResult.initial(true)));
  }
  return {
    registry,
    [Symbol.dispose]() {
      registry.dispose();
      state.handoffs.clear();
    },
  };
}

function indicator(registry: AtomRegistry.AtomRegistry, threadId = "first") {
  return (
    <RegistryContext.Provider value={registry}>
      <TooltipProvider>
        <ThreadHandoffIndicator
          threadRef={{
            environmentId: EnvironmentId.make("source"),
            threadId: ThreadId.make(threadId),
          }}
        />
      </TooltipProvider>
    </RegistryContext.Provider>
  );
}

async function answer(
  registry: AtomRegistry.AtomRegistry,
  result: HandoffResult,
  threadId = "first",
) {
  await act(async () => registry.set(state.handoffs.get(threadId)!, result));
}

it("resolves an empty owner journal while continuing to receive transfer updates", async () => {
  using harness = setup();
  const { registry } = harness;
  await using screen = await render(indicator(registry), { router: false });
  expect(screen.container.textContent).toBe("Checking execution owner…");

  // An open watch remains waiting even after its initial null response.
  await answer(registry, AsyncResult.success(null, { waiting: true }));
  expect(screen.container.textContent).toBe("Running on My computer");

  const record = decodeHandoffRecord({
    handoffId: "transfer",
    owner: { threadId: "first", environmentId: "source", generation: 0 },
    destinationEnvironmentId: "destination",
    phase: "pausing",
    revision: 1,
    createdAt: "2026-10-08T12:00:00Z",
    updatedAt: "2026-10-08T12:00:00Z",
    failure: null,
  });
  await answer(registry, AsyncResult.success(record, { waiting: true }));
  expect(screen.container.textContent).toBe("Running on My computerPausing agent");
});

it("shows a connection failure and resolves the owner after reconnecting", async () => {
  using harness = setup();
  const { registry } = harness;
  await using screen = await render(indicator(registry), { router: false });
  await answer(registry, AsyncResult.fail(new Error("Offline")));
  expect(screen.container.textContent).toBe(
    "Execution owner unavailableOwnership connection unavailable",
  );

  await answer(registry, AsyncResult.initial(true));
  expect(screen.container.textContent).toBe("Checking execution owner…");
  await answer(registry, AsyncResult.success(null, { waiting: true }));
  expect(screen.container.textContent).toBe("Running on My computer");
});

it("waits for the newly selected thread without reusing the previous thread's result", async () => {
  using harness = setup();
  const { registry } = harness;
  await using screen = await render(indicator(registry), { router: false });
  await answer(registry, AsyncResult.success(null, { waiting: true }));
  expect(screen.container.textContent).toBe("Running on My computer");

  await screen.rerender(indicator(registry, "second"));
  expect(screen.container.textContent).toBe("Checking execution owner…");
  await answer(registry, AsyncResult.success(null, { waiting: true }), "second");
  expect(screen.container.textContent).toBe("Running on My computer");
});
