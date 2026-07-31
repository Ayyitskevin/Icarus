import { IcarusError } from "@icarus/core";

export const DEFAULT_MAX_JSON_DEPTH = 64;

function invalidJson(message = "Request body must be valid JSON"): never {
  throw new IcarusError("INVALID_JSON", message);
}

class StrictJsonScanner {
  readonly #source: string;
  readonly #maxDepth: number;
  #index = 0;

  constructor(source: string, maxDepth: number) {
    this.#source = source;
    this.#maxDepth = maxDepth;
  }

  parseDocument(): void {
    this.#skipWhitespace();
    this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) invalidJson();
  }

  #parseValue(depth: number): void {
    const current = this.#source[this.#index];
    if (current === "{") {
      this.#parseObject(depth);
      return;
    }
    if (current === "[") {
      this.#parseArray(depth);
      return;
    }
    if (current === '"') {
      this.#parseString();
      return;
    }
    if (current === "t") {
      this.#parseLiteral("true");
      return;
    }
    if (current === "f") {
      this.#parseLiteral("false");
      return;
    }
    if (current === "n") {
      this.#parseLiteral("null");
      return;
    }
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) {
      this.#parseNumber();
      return;
    }
    invalidJson();
  }

  #enterContainer(depth: number): void {
    if (depth >= this.#maxDepth) {
      invalidJson("Request body exceeds the JSON nesting limit");
    }
  }

  #parseObject(depth: number): void {
    this.#enterContainer(depth);
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      if (this.#source[this.#index] !== '"') invalidJson();
      const key = this.#parseString();
      if (keys.has(key)) {
        invalidJson("Request body must not contain duplicate JSON object members");
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      if (delimiter === "}") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseArray(depth: number): void {
    this.#enterContainer(depth);
    this.#index += 1;
    this.#skipWhitespace();
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return;
    }

    while (true) {
      this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const delimiter = this.#source[this.#index];
      if (delimiter === "]") {
        this.#index += 1;
        return;
      }
      if (delimiter !== ",") invalidJson();
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index] ?? "";
      if (character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.#source.slice(start, this.#index)) as string;
        } catch {
          invalidJson();
        }
      }
      if (character.charCodeAt(0) < 0x20) invalidJson();
      if (character === "\\") {
        this.#index += 1;
        const escaped = this.#source[this.#index];
        if (escaped === undefined) invalidJson();
        if (escaped === "u") {
          const code = this.#source.slice(this.#index + 1, this.#index + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(code)) invalidJson();
          this.#index += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) invalidJson();
      }
      this.#index += 1;
    }
    invalidJson();
  }

  #parseLiteral(literal: "true" | "false" | "null"): void {
    if (this.#source.slice(this.#index, this.#index + literal.length) !== literal) {
      invalidJson();
    }
    this.#index += literal.length;
  }

  #parseNumber(): void {
    const start = this.#index;
    if (this.#source[this.#index] === "-") this.#index += 1;
    const firstDigit = this.#source[this.#index];
    if (firstDigit === "0") {
      this.#index += 1;
    } else if (firstDigit !== undefined && firstDigit >= "1" && firstDigit <= "9") {
      this.#index += 1;
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    } else {
      invalidJson();
    }

    if (this.#source[this.#index] === ".") {
      this.#index += 1;
      if (!this.#isDigit(this.#source[this.#index])) invalidJson();
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    }

    const exponent = this.#source[this.#index];
    if (exponent === "e" || exponent === "E") {
      this.#index += 1;
      const sign = this.#source[this.#index];
      if (sign === "+" || sign === "-") this.#index += 1;
      if (!this.#isDigit(this.#source[this.#index])) invalidJson();
      while (this.#isDigit(this.#source[this.#index])) this.#index += 1;
    }

    if (!Number.isFinite(Number(this.#source.slice(start, this.#index)))) {
      invalidJson("Request body must not contain a non-finite number");
    }
  }

  #isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  #skipWhitespace(): void {
    while (true) {
      const character = this.#source[this.#index];
      if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") {
        return;
      }
      this.#index += 1;
    }
  }
}

export function parseStrictJson(source: string, maxDepth = DEFAULT_MAX_JSON_DEPTH): unknown {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) {
    invalidJson("Request body has an invalid JSON nesting limit");
  }
  new StrictJsonScanner(source, maxDepth).parseDocument();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    invalidJson();
  }
}
