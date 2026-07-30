import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function schemaEnvKeys(): string[] {
  const envSource = readFileSync(join(root, "lib/env.ts"), "utf8");
  return Array.from(envSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]{3,}):/gm), (match) => match[1]!)
    .filter((key) => key !== "NODE_ENV")
    .sort();
}

function exampleEnvKeys(): string[] {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  return Array.from(example.matchAll(/^([A-Z][A-Z0-9_]{3,})=/gm), (match) => match[1]!).sort();
}

describe(".env.example", () => {
  it("documenta todas as variáveis validadas em lib/env.ts", () => {
    const documented = new Set(exampleEnvKeys());
    const missing = schemaEnvKeys().filter((key) => !documented.has(key));

    expect(missing).toEqual([]);
  });
});
