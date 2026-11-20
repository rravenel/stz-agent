// Pick the model adapter from the environment (spec §5.3: chosen by config,
// not per turn). Prime holds no API keys: Com adds auth per the request's
// auth mode.
//
//   MODEL_PROVIDER  anthropic | openai | mock   (bedrock: not yet, see issues)
//   MODEL_NAME      provider's model id (mock: any label)
//   OPENAI_BASE_URL required for openai, e.g. https://api.openai.com/v1

import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";
import type { ModelAdapter } from "./turn.ts";

export const MOCK_URL = "mock://model";

export function adapterFromEnv(env: Record<string, string | undefined> = process.env): ModelAdapter {
  const provider = (env["MODEL_PROVIDER"] ?? "").trim();
  const model = (env["MODEL_NAME"] ?? "").trim();
  if (provider === "mock") return anthropicAdapter({ model: model || "mock", url: MOCK_URL, auth: "mock" });
  if (!["anthropic", "openai", "bedrock"].includes(provider)) {
    throw new Error(`MODEL_PROVIDER must be anthropic, openai or mock, got ${JSON.stringify(provider)}`);
  }
  if (!model) throw new Error("MODEL_NAME is required");
  switch (provider) {
    case "anthropic":
      return anthropicAdapter({ model });
    case "openai": {
      const baseUrl = (env["OPENAI_BASE_URL"] ?? "").trim();
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("OPENAI_BASE_URL must be an http(s) URL for MODEL_PROVIDER=openai");
      return openaiAdapter({ model, baseUrl });
    }
    case "bedrock":
      throw new Error("MODEL_PROVIDER=bedrock is not implemented yet (#0021)");
    default:
      throw new Error(`MODEL_PROVIDER must be anthropic, openai or mock, got ${JSON.stringify(provider)}`);
  }
}
