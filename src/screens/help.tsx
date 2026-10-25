import { PageHeader } from "../components/ui";

const SECTIONS = [
  {
    title: "Joining the workspace",
    body: "Anyone can sign in with Google. The first administrator opens the workspace immediately. Everyone else stays on a waiting screen until they accept an invitation sent to their email. That request appears even if they signed in before the invite was sent. People can belong to several groups. Work in a group is assigned only to people in that group. Chat shows your groups and the people you have already messaged.",
  },
  {
    title: "Tasks, bugs, and features",
    body: "Every workspace can track tasks, bugs, and features. Drag a card between To Do, In Progress, Under Review, Blocked, and Completed when that move is allowed. The person who last assigned the work is the reviewer. The assignee updates it and sends it to Under Review. That reviewer approves it or sends it back. For a bug, Under Review means it is ready to verify. Employees cannot change the deadline, priority, or mark it completed.",
  },
  {
    title: "Your profile name",
    body: "Open Settings or your own profile and save the name people should see. That name appears in the directory, on your profile, and in the sidebar. In a task update, type @ and choose a person. They are notified, and the tag keeps pointing at them if they later change their name.",
  },
  {
    title: "Meetings and availability",
    body: "Sign in with Google to connect your calendar. An online meeting creates a Google Meet link, adds everyone to the calendar, and emails a reminder to join. An in-person meeting blocks that time and does not create a Meet link. A calendar that cannot be read stays Availability unknown. It is never shown as free.",
  },
  {
    title: "Reporting",
    body: "Overview has an Export button. The file contains only the work you are allowed to see. It is a spreadsheet, and values that could be read as formulas are neutralised.",
  },
  {
    title: "Keyboard",
    body: "Ctrl K or Cmd K opens search. Escape closes a drawer. Enter chooses a highlighted person in a search field.",
  },
];

export function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Help" subtitle="How Goyal Workspace handles teams, work, and calendars." />
      <div className="space-y-3">
        {SECTIONS.map((section) => (
          <section key={section.title} className="rounded-xl border border-line bg-white p-4">
            <h2 className="text-[14px] font-semibold">{section.title}</h2>
            <p className="mt-2 text-[13px] leading-6 text-muted">{section.body}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
