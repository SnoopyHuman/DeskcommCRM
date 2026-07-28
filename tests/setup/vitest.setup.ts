import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env and .env.local before importing any app code that validates env vars
for (const envFile of [".env", ".env.local"]) {
  try {
    const path = resolve(process.cwd(), envFile);
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (key && !process.env[key]) {
        process.env[key] = rest.join("=");
      }
    }
  } catch {
    // File doesn't exist, skip
  }
}

/**
 * Placeholders para as vars que `lib/env.ts` exige na IMPORTAÇÃO.
 *
 * Sem isto, qualquer arquivo de teste que importe (mesmo transitivamente) um
 * módulo que toque `@/lib/env` **não carrega** onde não há `.env` — e o CI é
 * exatamente esse lugar. O sintoma é cruel: some o arquivo inteiro em vez de
 * falhar um teste, então a contagem cai e ninguém vê que a cobertura evaporou.
 * Foi o que aconteceu no PR #58: 4 arquivos com 0 testes rodados, e o número
 * verde de 1322 escondendo que 3 deles eram novos.
 *
 * É o mesmo remédio que `lib/env.ts:155` já aplica na fase de build da imagem
 * ("semeia placeholders pras vars que faltam e revalida"), aqui restrito ao
 * setup de teste — a lógica de produção não é tocada.
 *
 * `??=` de propósito: valor real de `.env`/`.env.local` SEMPRE vence, então
 * localmente nada muda. E o host `.invalid` é reservado por RFC 2606: se algum
 * teste tentar usar isto como URL de verdade, a chamada falha alto em vez de
 * bater em algum lugar existente.
 */
const PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test-placeholder.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-placeholder-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-placeholder-service-role-key",
};
for (const [chave, valor] of Object.entries(PLACEHOLDERS)) {
  process.env[chave] ??= valor;
}

import "@testing-library/jest-dom/vitest";

// jsdom não implementa ResizeObserver; Radix (ex.: Switch) usa em layout effects.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
