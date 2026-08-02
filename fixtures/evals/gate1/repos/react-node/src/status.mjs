export function statusLabel(isOnline) {
  return isOnline ? "Offline" : "Online";
}

export function statusTone(isOnline) {
  return isOnline ? "muted" : "positive";
}
