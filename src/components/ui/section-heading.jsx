/** Section title with optional quiet kicker; keeps 城市漫游·明快 without shouty tracking. */
export function SectionHeading({ id = undefined, kicker = undefined, title, action = undefined }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {kicker && <span className="text-meta font-semibold tracking-wide text-primary-strong">{kicker}</span>}
        <h2 id={id} className="mt-1 text-title font-extrabold tracking-tight lg:text-display-sm">
          {title}
        </h2>
      </div>
      {action}
    </div>
  );
}
