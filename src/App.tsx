import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Button } from "./components/ui";
import { Shell } from "./components/shell";
import { ActivityPage } from "./screens/activity";
import { CalendarPage } from "./screens/calendar";
import { ChatPage } from "./screens/chat";
import { HelpPage } from "./screens/help";
import { LoginPage } from "./screens/login";
import { MyTasksPage } from "./screens/my-tasks";
import { OverviewPage } from "./screens/overview";
import { SettingsPage } from "./screens/settings";
import { EmployeeProfilePage, TeamPage } from "./screens/team";
import { WaitingPage } from "./screens/waiting";
import { WorkspaceGate } from "./state";

function Private() {
  return (
    <WorkspaceGate>
      {({ data, loading, error, unauthorized, retry }) => {
        if (unauthorized) return <Navigate to="/login" replace />;
        if (loading && !data) return <div className="grid min-h-screen place-items-center text-[13px] text-muted">Loading the workspace…</div>;
        if (error && !data) {
          return (
            <div className="grid min-h-screen place-items-center px-4">
              <div className="max-w-md text-center">
                <h1 className="text-[18px] font-semibold">The workspace could not be loaded</h1>
                <p className="mt-2 text-[13px] text-muted">{error}</p>
                <Button type="button" className="mt-4" onClick={retry}>Try again</Button>
              </div>
            </div>
          );
        }
        if (!data) return null;
        if (data.access === "waiting") return <WaitingPage />;
        return <Outlet />;
      }}
    </WorkspaceGate>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Private />}>
        <Route element={<Shell />}>
          <Route index element={<OverviewPage />} />
          <Route path="my-tasks" element={<MyTasksPage />} />
          <Route path="tasks" element={<Navigate to="/" replace />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="team/:id" element={<EmployeeProfilePage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="help" element={<HelpPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
