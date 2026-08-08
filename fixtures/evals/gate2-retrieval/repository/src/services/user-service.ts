import type { UserRecord } from "../models/user-record.js";

const users: readonly UserRecord[] = [];

export function findUser(id: string): UserRecord | undefined {
  return users.find((user) => user.id === id);
}
