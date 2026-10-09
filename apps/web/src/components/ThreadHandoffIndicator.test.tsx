// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, ThreadHandoffRecord } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const id of ["first", "second"]) {
    state.handoffs.set(id, Atom.make<HandoffResult>(AsyncResult.initial(true)));
  }
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  state.handoffs.clear();
  vi.unstubAllGlobals();
});

async function show(threadId = "first") {
  await act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <TooltipProvider>
          <ThreadHandoffIndicator
            threadRef={{
              environmentId: EnvironmentId.make("source"),
              threadId: ThreadId.make(threadId),
            }}
          />
        </TooltipProvider>
      </RegistryContext.Provider>,
    );
  });
}

async function answer(result: HandoffResult, threadId = "first") {
  await act(async () => registry.set(state.handoffs.get(threadId)!, result));
}

it("resolves an empty owner journal while continuing to receive transfer updates", async () => {
  await show();
  expect(container.textContent).toBe("Checking execution owner…");

  // An open watch remains waiting even after its initial null response.
  await answer(AsyncResult.success(null, { waiting: true }));
  expect(container.textContent).toBe("Running on My computer");

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
  await answer(AsyncResult.success(record, { waiting: true }));
  expect(container.textContent).toBe("Running on My computerPausing agent");
});

it("shows a connection failure and resolves the owner after reconnecting", async () => {
  await show();
  await answer(AsyncResult.fail(new Error("Offline")));
  expect(container.textContent).toBe("Execution owner unavailableOwnership connection unavailable");

  await answer(AsyncResult.initial(true));
  expect(container.textContent).toBe("Checking execution owner…");
  await answer(AsyncResult.success(null, { waiting: true }));
  expect(container.textContent).toBe("Running on My computer");
});

it("waits for the newly selected thread without reusing the previous thread's result", async () => {
  await show();
  await answer(AsyncResult.success(null, { waiting: true }));
  expect(container.textContent).toBe("Running on My computer");

  await show("second");
  expect(container.textContent).toBe("Checking execution owner…");
  await answer(AsyncResult.success(null, { waiting: true }), "second");
  expect(container.textContent).toBe("Running on My computer");
});
