export interface CiWorkflowSupplyChainValidation {
  readonly actions: readonly string[];
  readonly sha256: string;
}

export function validateCiWorkflowSupplyChain(source: string): CiWorkflowSupplyChainValidation;

export function validateWorkflowAttributes(source: string): {
  readonly rule: string;
};
