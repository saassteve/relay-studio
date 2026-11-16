// The one Relay mark, used everywhere the brand appears.
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`wordmark ${small ? "mini" : ""}`}>
      <svg viewBox="0 0 34 36" aria-hidden="true">
        <path d="M3 3h13a15 15 0 0 1 0 30H3V3Z" fill="currentColor" />
        <path d="m12 11 12 7-12 7Z" fill="var(--logo-cut, #f8f9f3)" />
      </svg>
      relay
    </span>
  );
}
