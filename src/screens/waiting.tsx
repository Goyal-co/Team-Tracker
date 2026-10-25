import { useState } from "react";
import { useWorkspace } from "../state";
import { useToast } from "../toast";
import { Button } from "../components/ui";

export function WaitingPage() {
  const { data, respondInvite, signOut } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const pending = data.invites.filter((invite) => invite.Status === "Pending" && invite.Email.toLowerCase() === data.me.Email.toLowerCase());

  async function respond(id: string, accept: boolean) {
    setBusy(id);
    try {
      await respondInvite(id, accept);
      toast(accept ? "You joined the team." : "Invite declined.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update the invite.", "error");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-lg rounded-xl border border-line bg-white p-6">
        <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Goyal Workspace</p>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight">You're signed in as {data.me.Name}</h1>
        <p className="mt-2 text-[13px] leading-5 text-muted">Accept an invitation to enter the workspace. This page checks for new invitations automatically.</p>
        <div className="mt-4 space-y-3">
          {pending.length === 0 && <p className="rounded-xl bg-canvas px-3 py-3 text-[13px] text-muted">No invitation yet for {data.me.Email}. Ask an administrator or group lead to invite this email.</p>}
          {pending.map((invite) => {
            const team = data.teams.find((item) => item.Team_ID === invite.Team_ID);
            return (
              <div key={invite.Invite_ID} className="rounded-xl border border-line px-3 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">Invitation request</p>
                <p className="mt-1 text-[14px] font-medium">{team?.Name || "A group"}</p>
                <p className="text-[12px] text-muted">{invite.Member_Role} · {invite.Access_Role}</p>
                <div className="mt-3 flex gap-2">
                  <Button type="button" disabled={busy === invite.Invite_ID} onClick={() => void respond(invite.Invite_ID, true)}>Accept</Button>
                  <Button type="button" variant="secondary" disabled={busy === invite.Invite_ID} onClick={() => void respond(invite.Invite_ID, false)}>Decline</Button>
                </div>
              </div>
            );
          })}
        </div>
        <button type="button" className="mt-4 text-[13px] text-accent" onClick={() => void signOut()}>Sign out</button>
      </div>
    </div>
  );
}
