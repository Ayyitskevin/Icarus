export interface NativeAcceptanceWorkflowValidation {
  readonly actions: readonly string[];
  readonly commands: number;
  readonly digest: string;
  readonly runners: readonly ("macos-15" | "windows-2025")[];
}

export interface NativeHostInput {
  readonly architecture: string;
  readonly configuredArchitecture: string | undefined;
  readonly configuredChromiumExecutable: string | undefined;
  readonly configuredPlatform: string | undefined;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly userAgent: string;
}

export interface NativeHostValidation {
  readonly architecture: "arm64" | "x64";
  readonly platform: "darwin" | "win32";
  readonly runner: "macos-15" | "windows-2025";
}

export function validateNativeAcceptanceWorkflow(
  source: string,
): NativeAcceptanceWorkflowValidation;

export function validateNativeAcceptanceFile(
  filePath?: string,
): Promise<NativeAcceptanceWorkflowValidation>;

export function validateNativeHost(input?: NativeHostInput): NativeHostValidation;
