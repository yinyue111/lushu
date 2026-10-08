/** @param {Record<string, any>} props */
export function SectionHeading({ id, kicker, title, action }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker && <span className="text-xs font-extrabold tracking-[0.08em] text-primary-strong">{kicker}</span>}
        <h2 id={id} className="mt-1 text-2xl font-extrabold tracking-tight lg:text-[28px]">
          {title}
        </h2>
      </div>
      {action}
    </div>
  );
}
