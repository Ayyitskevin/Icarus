import { statusLabel, statusTone } from "./status.mjs";

export function StatusCard({ name, isOnline }) {
  return (
    <section aria-label={`${name} status`} data-tone={statusTone(isOnline)}>
      <h2>{name}</h2>
      <p>{statusLabel(isOnline)}</p>
    </section>
  );
}
