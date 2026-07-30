import Link from "next/link";

/**
 * The rail lists the product surfaces. Only the surfaces this milestone
 * actually builds are navigable; the rest are labelled as later work rather
 * than presented as working features.
 */
const SURFACES = [
  { label: "Repository state", href: "/" },
  { label: "Impact workspace", href: "/demo/pr/284" },
] as const;

const LATER = [
  "Analysis progress",
  "Change Passport",
  "Repository settings",
] as const;

export function WorkspaceNav({ current }: { current: string }) {
  return (
    <nav className="rail" aria-label="Workspace">
      <p className="rail-brand">CodeAtlas</p>
      <ul className="rail-list">
        {SURFACES.map((surface) => (
          <li key={surface.href}>
            <Link
              className="rail-link"
              href={surface.href}
              aria-current={surface.href === current ? "true" : undefined}
            >
              {surface.label}
            </Link>
          </li>
        ))}
      </ul>
      <div>
        <p className="label">Later milestones</p>
        <ul className="rail-list">
          {LATER.map((label) => (
            <li key={label}>
              <span className="rail-link" aria-disabled="true">
                {label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
