// Узкие типы на границе с Agent SDK (АДР 002: всё зависит от них, не от SDK напрямую).
// Реальный SDK подключается только в sdk.ts — в тестах подставляется фейк.

import type { ContentBlock, Question } from '@perimeter/protocol';

/** Ответ на запрос разрешения — контракт canUseTool из SDK. */
export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  /** «всегда разрешать»: правило для сессии (SDK updatedPermissions) */
  updatedPermissions?: unknown;
  message?: string;
}

/** Кадр пользователя в стриминговом входе SDK. */
export interface SdkUserInput {
  type: 'user';
  message: { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> };
}

/** system/init — паспорт окружения (единственный system-подтип, который мапим в P0). */
export interface SystemInitMsg {
  type: 'system';
  subtype: 'init';
  session_id?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  model?: string;
  permissionMode?: string;
  slash_commands?: string[];
  agents?: string[];
  skills?: string[];
}

/** Минимальный перехват сообщений SDK, которые мы умеем мапить. */
export type SdkMsg =
  | SystemInitMsg
  | { type: 'system'; subtype: string; [k: string]: unknown }
  | {
      type: 'assistant';
      message: { id: string; content: unknown[] };
      parent_tool_use_id?: string | null;
    }
  | {
      type: 'user';
      message?: { content?: unknown };
      /** структурированный результат инструмента: в потоке SDK — snake_case (SDKUserMessage.tool_use_result) */
      tool_use_result?: unknown;
      /** то же поле в форме транскрипта (camelCase) — терпим оба написания */
      toolUseResult?: unknown;
      parent_tool_use_id?: string | null;
    }
  | {
      type: 'stream_event';
      event: {
        type: string;
        delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
        /** content_block_start: тип открывающегося блока (thinking/text/tool_use) */
        content_block?: { type?: string };
      };
      parent_tool_use_id?: string | null;
    }
  | {
      type: 'result';
      subtype: string;
      result?: string;
      total_cost_usd?: number;
      usage?: Record<string, number>;
      /** настоящий SDK: SDKResultMessage.modelUsage, ключи camelCase (inputTokens/outputTokens/costUSD) */
      modelUsage?: Record<string, Record<string, number>>;
      /** устаревшее/моковое snake_case-написание — терпим */
      model_usage?: Record<string, Record<string, number>>;
      num_turns?: number;
      duration_ms?: number;
      permission_denials?: unknown[] | number;
    };

/** Подмножество Query из SDK, которым пользуется engine. */
export interface QueryLike extends AsyncIterable<SdkMsg> {
  interrupt(): Promise<unknown>;
  close?: () => Promise<void>;
  /** контрольные методы SDK (есть у настоящего Query; в моках опциональны) */
  setModel?: (model: string) => Promise<unknown>;
  setPermissionMode?: (mode: string) => Promise<unknown>;
  getContextUsage?: (detail?: 'summary' | 'full') => Promise<unknown>;
  /** флаги сессии на лету: { effortLevel, ultracode } (SDK applyFlagSettings, только стриминговый ввод) */
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<unknown>;
}

export type SdkMsgContentBlock = ContentBlock | Question; // re-export для удобства тестов
