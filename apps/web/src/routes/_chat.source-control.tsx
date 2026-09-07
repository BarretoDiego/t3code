import { createFileRoute } from "@tanstack/react-router";
import { SourceControlHub } from "../components/sourceControl/SourceControlHub";
export const Route = createFileRoute("/_chat/source-control")({ component: SourceControlHub });
