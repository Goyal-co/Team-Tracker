import { useEffect, useState } from "react";
import { Building2, Calendar, ListChecks, Shield, Users } from "lucide-react";
import { api } from "../api";
import type { SystemInfo } from "../domain/types";

const LOGIN_BG = "/images/auth/customer-login-bg.png";

const TRUST_POINTS = [
  { icon: ListChecks, text: "Tasks, bugs, and features" },
  { icon: Calendar, text: "Meetings on Google Calendar" },
  { icon: Shield, text: "Invitations before workspace access" },
];

const STATS = [
  { label: "Years", value: "55+", icon: Building2 },
  { label: "Projects", value: "250+", icon: Building2 },
  { label: "Loyal Customers", value: "30+", icon: Users },
];

export function LoginPage() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (code === "unknown") return "Google could not finish sign-in. Try again.";
    if (code === "calendar") return "Google did not complete sign-in. Try again and accept the requested permissions.";
    return "";
  });

  useEffect(() => {
    void api<SystemInfo>("/api/system")
      .then(setSystem)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div
      className="relative min-h-[100dvh] bg-[#f8f6f2]"
      style={{
        backgroundImage: `url(${LOGIN_BG})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}
    >
      <div className="absolute inset-0 bg-white/55 backdrop-blur-[0.5px]" aria-hidden="true" />
      <div className="relative flex min-h-[100dvh] flex-col lg:flex-row">
        <aside className="hidden w-[48%] shrink-0 flex-col justify-between p-10 lg:flex xl:p-12">
          <div>
            <img src="/new_logo.jpeg" alt="Goyal Hariyana" className="mb-10 h-20 w-auto max-w-[380px] object-contain object-left" />
            <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#C9A84C]">
              <Building2 className="h-4 w-4" />
              Building trust. Creating landmarks.
            </div>
            <h2 className="max-w-lg font-['Playfair_Display'] text-4xl leading-tight text-[#1A2332] xl:text-[2.75rem]">
              Welcome to your <span className="text-[#C9A84C]">company workspace</span>
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-[#64748B]">
              Tasks, meetings, and team accountability in one secure place.
            </p>
          </div>
          <div>
            <div className="grid grid-cols-3 gap-4 rounded-2xl border border-[#E2E8F0]/60 bg-white/90 p-6 shadow-[0_4px_24px_rgba(26,35,50,0.08)]">
              {STATS.map(({ label, value, icon: Icon }) => (
                <div key={label} className="text-center">
                  <Icon className="mx-auto mb-2 h-5 w-5 text-[#C9A84C]" />
                  <p className="text-2xl font-bold text-[#C9A84C]">{value}</p>
                  <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-[#64748B]">{label}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-2xl border border-[#E2E8F0]/60 bg-white/95 p-6 shadow-[0_4px_24px_rgba(26,35,50,0.08)]">
              <div className="mb-3 flex items-center gap-2">
                <Shield className="h-5 w-5 text-[#C9A84C]" />
                <p className="font-semibold text-[#1A2332]">A Legacy Built on Trust</p>
              </div>
              <p className="text-sm leading-relaxed text-[#64748B]">
                For over five decades, Goyal & Co. | Hariyana Group has been delivering excellence in real estate with unwavering commitment to quality, transparency & customer satisfaction.
              </p>
            </div>
          </div>
        </aside>

        <main className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8">
          <img src="/new_logo.jpeg" alt="Goyal Hariyana" className="mb-6 h-16 w-auto max-w-[300px] object-contain object-left lg:hidden" />
          <div className="w-full max-w-md rounded-2xl border border-[#E2E8F0]/60 bg-white p-6 shadow-[0_4px_24px_rgba(26,35,50,0.08)] sm:p-8">
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#F5EDD6]">
                <Shield className="h-6 w-6 text-[#C9A84C]" />
              </div>
              <h2 className="font-['Playfair_Display'] text-2xl font-semibold text-[#1A2332]">Log in to continue</h2>
              <p className="mt-1 text-sm text-[#64748B]">Sign in with your Google account.</p>
            </div>

            <ul className="mb-6 space-y-2 rounded-lg bg-blue-50/80 p-4">
              {TRUST_POINTS.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-2 text-xs text-[#64748B]">
                  <Icon className="h-4 w-4 shrink-0 text-[#C9A84C]" />
                  {text}
                </li>
              ))}
            </ul>

            {error && (
              <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</div>
            )}

            {system?.calendarOAuthReady ? (
              <a href="/api/auth/google/start" className="flex h-12 w-full items-center justify-center rounded-lg bg-[#C9A84C] text-base font-medium text-white shadow-sm hover:bg-[#B8943F]">
                Sign in with Google
              </a>
            ) : system ? (
              <p className="text-sm leading-6 text-[#64748B]">Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server, then restart.</p>
            ) : null}

            <p className="mt-6 text-center text-xs text-[#64748B]">
              The first administrator is the address set as BOOTSTRAP_ADMIN_EMAIL. Everyone else signs in, then waits until a team invitation is accepted.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
