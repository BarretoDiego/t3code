import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { rejectUnknownCommand, UnknownCommandError } from "./server.ts";

it.layer(NodeServices.layer)("t3 server working directory", (it) => {
  it.effect("treats a bare word that is not a directory as an unknown command", () =>
    Effect.gen(function* () {
      const error = yield* rejectUnknownCommand(Option.some("no-such-t3-command")).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, UnknownCommandError);
      assert.include(error.message, "t3 --help");
    }),
  );

  it.effect("still accepts existing directories and explicit new paths", () =>
    Effect.gen(function* () {
      yield* rejectUnknownCommand(Option.none());
      yield* rejectUnknownCommand(Option.some("src"));
      yield* rejectUnknownCommand(Option.some("./no-such-folder-yet"));
      yield* rejectUnknownCommand(Option.some("~/no-such-folder-yet"));
    }),
  );
});
