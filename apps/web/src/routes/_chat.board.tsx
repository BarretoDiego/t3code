import { createFileRoute } from "@tanstack/react-router";

import { AgentBoardPage } from "../components/agentBoard/AgentBoardPage";
import { parseAgentBoardSearch } from "../agentBoardSearch";

export const Route = createFileRoute("/_chat/board")({
  validateSearch: parseAgentBoardSearch,
  component: AgentBoardPage,
});
