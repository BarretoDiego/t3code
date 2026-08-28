import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono";
import Azure from "@lobehub/icons/es/Azure/components/Mono";
import Baichuan from "@lobehub/icons/es/Baichuan/components/Mono";
import Bedrock from "@lobehub/icons/es/Bedrock/components/Mono";
import Claude from "@lobehub/icons/es/Claude/components/Mono";
import Cline from "@lobehub/icons/es/Cline/components/Mono";
import Codex from "@lobehub/icons/es/Codex/components/Mono";
import Cohere from "@lobehub/icons/es/Cohere/components/Mono";
import Copilot from "@lobehub/icons/es/Copilot/components/Mono";
import Cursor from "@lobehub/icons/es/Cursor/components/Mono";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono";
import Doubao from "@lobehub/icons/es/Doubao/components/Mono";
import Fireworks from "@lobehub/icons/es/Fireworks/components/Mono";
import Gemini from "@lobehub/icons/es/Gemini/components/Mono";
import Grok from "@lobehub/icons/es/Grok/components/Mono";
import Groq from "@lobehub/icons/es/Groq/components/Mono";
import Hunyuan from "@lobehub/icons/es/Hunyuan/components/Mono";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono";
import KiloCode from "@lobehub/icons/es/KiloCode/components/Mono";
import LmStudio from "@lobehub/icons/es/LmStudio/components/Mono";
import Meta from "@lobehub/icons/es/Meta/components/Mono";
import Minimax from "@lobehub/icons/es/Minimax/components/Mono";
import Mistral from "@lobehub/icons/es/Mistral/components/Mono";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono";
import Nvidia from "@lobehub/icons/es/Nvidia/components/Mono";
import Ollama from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenClaw from "@lobehub/icons/es/OpenClaw/components/Mono";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono";
import Perplexity from "@lobehub/icons/es/Perplexity/components/Mono";
import Pi from "@lobehub/icons/es/Pi/components/Mono";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono";
import RooCode from "@lobehub/icons/es/RooCode/components/Mono";
import Spark from "@lobehub/icons/es/Spark/components/Mono";
import Stepfun from "@lobehub/icons/es/Stepfun/components/Mono";
import Together from "@lobehub/icons/es/Together/components/Mono";
import Trae from "@lobehub/icons/es/Trae/components/Mono";
import VertexAI from "@lobehub/icons/es/VertexAI/components/Mono";
import Vllm from "@lobehub/icons/es/Vllm/components/Mono";
import Wenxin from "@lobehub/icons/es/Wenxin/components/Mono";
import Windsurf from "@lobehub/icons/es/Windsurf/components/Mono";
import Yi from "@lobehub/icons/es/Yi/components/Mono";
import Zhipu from "@lobehub/icons/es/Zhipu/components/Mono";
import type { IconType } from "@lobehub/icons/es/types";

export interface ProviderIconChoice {
  /** Stable key persisted on `ProviderInstanceConfig.icon`. */
  readonly key: string;
  readonly label: string;
  readonly Icon: IconType;
}

/**
 * Curated AI provider icon registry, backed by @lobehub/icons. Only the
 * monochrome SVG component of each brand is imported — the package root and
 * its Avatar/Combine variants pull in @lobehub/ui and emoji data we never
 * render here.
 *
 * Provider instances reference entries by `key`; unknown keys fall back to
 * the driver icon so a config written by a newer build still renders on
 * older clients.
 */
export const PROVIDER_ICON_CHOICES: ReadonlyArray<ProviderIconChoice> = [
  { key: "claude", label: "Claude", Icon: Claude },
  { key: "anthropic", label: "Anthropic", Icon: Anthropic },
  { key: "openai", label: "OpenAI", Icon: OpenAI },
  { key: "codex", label: "Codex", Icon: Codex },
  { key: "kimi", label: "Kimi", Icon: Kimi },
  { key: "moonshot", label: "Moonshot AI", Icon: Moonshot },
  { key: "deepseek", label: "DeepSeek", Icon: DeepSeek },
  { key: "zhipu", label: "Zhipu GLM", Icon: Zhipu },
  { key: "minimax", label: "MiniMax", Icon: Minimax },
  { key: "qwen", label: "Qwen", Icon: Qwen },
  { key: "gemini", label: "Gemini", Icon: Gemini },
  { key: "grok", label: "Grok", Icon: Grok },
  { key: "mistral", label: "Mistral", Icon: Mistral },
  { key: "cohere", label: "Cohere", Icon: Cohere },
  { key: "perplexity", label: "Perplexity", Icon: Perplexity },
  { key: "openrouter", label: "OpenRouter", Icon: OpenRouter },
  { key: "ollama", label: "Ollama", Icon: Ollama },
  { key: "lmstudio", label: "LM Studio", Icon: LmStudio },
  { key: "vllm", label: "vLLM", Icon: Vllm },
  { key: "cursor", label: "Cursor", Icon: Cursor },
  { key: "windsurf", label: "Windsurf", Icon: Windsurf },
  { key: "trae", label: "Trae", Icon: Trae },
  { key: "opencode", label: "OpenCode", Icon: OpenCode },
  { key: "kilocode", label: "Kilo Code", Icon: KiloCode },
  { key: "roocode", label: "Roo Code", Icon: RooCode },
  { key: "cline", label: "Cline", Icon: Cline },
  { key: "copilot", label: "GitHub Copilot", Icon: Copilot },
  { key: "vertexai", label: "Vertex AI", Icon: VertexAI },
  { key: "bedrock", label: "AWS Bedrock", Icon: Bedrock },
  { key: "azure", label: "Azure AI", Icon: Azure },
  { key: "doubao", label: "Doubao", Icon: Doubao },
  { key: "hunyuan", label: "Hunyuan", Icon: Hunyuan },
  { key: "yi", label: "Yi", Icon: Yi },
  { key: "baichuan", label: "Baichuan", Icon: Baichuan },
  { key: "stepfun", label: "StepFun", Icon: Stepfun },
  { key: "wenxin", label: "Wenxin", Icon: Wenxin },
  { key: "spark", label: "Spark", Icon: Spark },
  { key: "nvidia", label: "NVIDIA", Icon: Nvidia },
  { key: "meta", label: "Meta", Icon: Meta },
  { key: "together", label: "Together AI", Icon: Together },
  { key: "fireworks", label: "Fireworks", Icon: Fireworks },
  { key: "groq", label: "Groq", Icon: Groq },
  { key: "openclaw", label: "OpenClaw", Icon: OpenClaw },
  { key: "pi", label: "Pi", Icon: Pi },
];

export const PROVIDER_ICON_CHOICES_BY_KEY: ReadonlyMap<string, ProviderIconChoice> = new Map(
  PROVIDER_ICON_CHOICES.map((choice) => [choice.key, choice]),
);

export function resolveProviderIconChoice(key: string | undefined): ProviderIconChoice | null {
  if (!key) return null;
  return PROVIDER_ICON_CHOICES_BY_KEY.get(key) ?? null;
}
