import type { GitController, TreeEntry } from "../../packages/core/src/git.js";

export const SANDBOX_TARGET = "src/greeting.txt";
export const SANDBOX_BASE_COMMIT = "b".repeat(40);
export const SANDBOX_EDITED_TEXT = "hello from the guarded workspace\n";

const TARGET_OBJECT_ID = "1".repeat(40);
const README_OBJECT_ID = "2".repeat(40);

export interface SandboxGitFixture {
  readonly git: GitController;
  readonly calls: {
    readonly listTree: string[];
    readonly readBlob: string[];
    readonly readRegularUtf8File: string[];
  };
}

export function createSandboxGitFixture(): SandboxGitFixture {
  const calls = {
    listTree: [] as string[],
    readBlob: [] as string[],
    readRegularUtf8File: [] as string[],
  };
  const tree: readonly TreeEntry[] = [
    { mode: "100644", type: "blob", objectId: README_OBJECT_ID, path: "README.md" },
    { mode: "100644", type: "blob", objectId: TARGET_OBJECT_ID, path: SANDBOX_TARGET },
  ];
  const fake = {
    async listTree(repositoryPath: string, commit: string): Promise<readonly TreeEntry[]> {
      calls.listTree.push(`${repositoryPath}:${commit}`);
      return tree;
    },
    async readBlob(_repositoryPath: string, objectId: string): Promise<Buffer> {
      calls.readBlob.push(objectId);
      if (objectId !== README_OBJECT_ID) {
        throw new Error(`Unexpected object ID: ${objectId}`);
      }
      return Buffer.from("# Wire fixture\n", "utf8");
    },
    async readRegularUtf8File(_repositoryPath: string, target: string): Promise<string> {
      calls.readRegularUtf8File.push(target);
      if (target !== SANDBOX_TARGET) {
        throw new Error(`Unexpected target: ${target}`);
      }
      return SANDBOX_EDITED_TEXT;
    },
  };
  return { git: fake as unknown as GitController, calls };
}
