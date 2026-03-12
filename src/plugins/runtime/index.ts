import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnAcpDirect } from "../../agents/acp-spawn.js";
import {
  getApiKeyForModel as getApiKeyForModelRaw,
  resolveApiKeyForProvider as resolveApiKeyForProviderRaw,
} from "../../agents/model-auth.js";
import { loadConfig } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { callGateway } from "../../gateway/call.js";
import { transcribeAudioFile } from "../../media-understanding/transcribe-audio.js";
import { textToSpeechTelephony } from "../../tts/tts.js";
import { createRuntimeChannel } from "./runtime-channel.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeMedia } from "./runtime-media.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTools } from "./runtime-tools.js";
import type { PluginRuntime } from "./types.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

function createUnavailableSubagentRuntime(): PluginRuntime["subagent"] {
  const unavailable = () => {
    throw new Error("Plugin runtime subagent methods are only available during a gateway request.");
  };
  return {
    run: unavailable,
    waitForRun: unavailable,
    getSessionMessages: unavailable,
    getSession: unavailable,
    deleteSession: unavailable,
  };
}

export type CreatePluginRuntimeOptions = {
  subagent?: PluginRuntime["subagent"];
};

export function createPluginRuntime(_options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const runtime = {
    version: resolveVersion(),
    config: createRuntimeConfig(),
    subagent: _options.subagent ?? createUnavailableSubagentRuntime(),
    system: createRuntimeSystem(),
    media: createRuntimeMedia(),
    tts: { textToSpeechTelephony },
    stt: { transcribeAudioFile },
    tools: createRuntimeTools(),
    channel: createRuntimeChannel(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    acp: {
      spawn: (...args: Parameters<typeof spawnAcpDirect>) => {
        const cfg = loadConfig();
        if (!cfg.plugins?.allowAcpSpawn) {
          throw new Error(
            "api.runtime.acp.spawn() requires plugins.allowAcpSpawn: true in openclaw.json",
          );
        }
        return spawnAcpDirect(...args);
      },
      prompt: async (params: {
        sessionKey: string;
        text: string;
        channel?: string;
        accountId?: string;
        threadId?: string;
      }) => {
        const cfg = loadConfig();
        if (!cfg.plugins?.allowAcpSpawn) {
          throw new Error(
            "api.runtime.acp.prompt() requires plugins.allowAcpSpawn: true in openclaw.json",
          );
        }
        const deliver = Boolean(params.channel && params.threadId);
        const to = params.threadId ? `channel:${params.threadId}` : undefined;
        const idem = crypto.randomUUID();
        const response = await callGateway<{ runId?: string }>({
          method: "agent",
          params: {
            message: params.text,
            sessionKey: params.sessionKey,
            channel: deliver ? params.channel : undefined,
            to: deliver ? to : undefined,
            accountId: deliver ? params.accountId : undefined,
            threadId: deliver ? params.threadId : undefined,
            deliver,
            idempotencyKey: idem,
          },
          timeoutMs: 10_000,
        });
        const runId = typeof response?.runId === "string" ? response.runId.trim() : idem;
        return { runId };
      },
    },
    modelAuth: {
      // Wrap model-auth helpers so plugins cannot steer credential lookups:
      // - agentDir / store: stripped (prevents reading other agents' stores)
      // - profileId / preferredProfile: stripped (prevents cross-provider
      //   credential access via profile steering)
      // Plugins only specify provider/model; the core auth pipeline picks
      // the appropriate credential automatically.
      getApiKeyForModel: (params) =>
        getApiKeyForModelRaw({
          model: params.model,
          cfg: params.cfg,
        }),
      resolveApiKeyForProvider: (params) =>
        resolveApiKeyForProviderRaw({
          provider: params.provider,
          cfg: params.cfg,
        }),
    },
  } satisfies PluginRuntime;

  return runtime;
}

export type { PluginRuntime } from "./types.js";
