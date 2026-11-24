// Pick the model adapter from the environment (spec §5.3: chosen by config,
// not per turn). Prime holds no API keys: Com adds auth per the request's
// auth mode.
//
//   MODEL_PROVIDER  anthropic | openai | bedrock | mock
//   MODEL_NAME      provider's model id (mock: any label)
//   BEDROCK_REGION  for bedrock; defaults to AWS_REGION (set by Lambda)
//   OPENAI_BASE_URL required for openai, e.g. https://api.openai.com/v1
//   OPENAI_MAX_TOKENS_FIELD  max_tokens (default) | max_completion_tokens

import { anthropicAdapter } from "./anthropic.ts";
import { bedrockAdapter } from "./bedrock.ts";
import { openaiAdapter } from "./openai.ts";
import type { ModelAdapter } from "./turn.ts";

export const MOCK_URL = "mock://model";

export function adapterFromEnv(env: Record<string, string | undefined> = process.env): ModelAdapter {
  const provider = (env["MODEL_PROVIDER"] ?? "").trim();
  const model = (env["MODEL_NAME"] ?? "").trim();
  if (provider === "mock") return anthropicAdapter({ model: model || "mock", url: MOCK_URL, auth: "mock" });
  if (!["anthropic", "openai", "bedrock"].includes(provider)) {
    throw new Error(`MODEL_PROVIDER must be anthropic, openai, bedrock or mock, got ${JSON.stringify(provider)}`);
  }
  if (!model) throw new Error("MODEL_NAME is required");
  switch (provider) {
    case "anthropic":
      return anthropicAdapter({ model });
    case "openai": {
      const baseUrl = (env["OPENAI_BASE_URL"] ?? "").trim();
      if (!/^https?:\/\//.test(baseUrl)) throw new Error("OPENAI_BASE_URL must be an http(s) URL for MODEL_PROVIDER=openai");
      const field = (env["OPENAI_MAX_TOKENS_FIELD"] ?? "").trim() || "max_tokens";
      if (field !== "max_tokens" && field !== "max_completion_tokens") {
        throw new Error(`OPENAI_MAX_TOKENS_FIELD must be max_tokens or max_completion_tokens, got ${JSON.stringify(field)}`);
      }
      return openaiAdapter({ model, baseUrl, maxTokensField: field });
    }
    case "bedrock": {
      const region = (env["BEDROCK_REGION"] ?? env["AWS_REGION"] ?? "").trim();
      if (!/^[a-z0-9-]+$/.test(region)) throw new Error("BEDROCK_REGION or AWS_REGION is required for MODEL_PROVIDER=bedrock");
      return bedrockAdapter({ model, region });
    }
    default:
      throw new Error(`MODEL_PROVIDER must be anthropic, openai, bedrock or mock, got ${JSON.stringify(provider)}`);
  }
}
