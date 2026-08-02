export function statusLabel(isOnline) {
  return isOnline ? "Online" : "Offline";
}

export function statusTone(isOnline) {
  return isOnline ? "positive" : "muted";
}
