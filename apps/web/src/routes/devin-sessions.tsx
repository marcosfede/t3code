import { createFileRoute } from "@tanstack/react-router";

import { DevinSessionsPage } from "../components/devinSessions/DevinSessionsPage";

export const Route = createFileRoute("/devin-sessions")({
  component: DevinSessionsPage,
});
