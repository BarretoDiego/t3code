import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { squashAtomCommandFailure, type AtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";

/** Mounted queries only; the server owns caching, and navigation discards late responses. */
export function useHubQuery<W, A, E>(command: AtomCommand<W, A, E>, input: W) {
  const execute = useAtomCommand(command, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const inputKey = JSON.stringify(input);
  const key = `${inputKey}:${revision}`;
  const generation = useRef(0);
  const [state, setState] = useState<{
    key: string;
    inputKey: string;
    data: A | null;
    error: string | null;
  } | null>(null);
  const load = useEffectEvent(async (requestKey: string) => {
    const current = ++generation.current;
    const result = await execute(input);
    if (current !== generation.current) return;
    if (result._tag === "Success")
      setState({ key: requestKey, inputKey, data: result.value, error: null });
    else {
      const error = squashAtomCommandFailure(result);
      setState({
        key: requestKey,
        inputKey,
        data: null,
        error: error instanceof Error ? error.message : "Source control request failed.",
      });
    }
  });
  useEffect(() => {
    // State changes only after the remote request resolves; no synchronous render update.
    // eslint-disable-next-line react/set-state-in-effect
    void load(key);
    return () => {
      generation.current++;
    };
  }, [key]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    data: state?.inputKey === inputKey ? state.data : null,
    error: state?.key === key ? state.error : null,
    pending: state?.key !== key,
    refresh,
  };
}
