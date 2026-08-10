import { resolve } from "node:path";
import { z } from "zod";

const EnvironmentSchema = z.object({
  MYCEL_DATA_DIR: z.string().default(".local/mycel"),
  MYCEL_TARGET_REPO: z.string().default(".local/demo-repo"),
  MYCEL_PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  MYCEL_CLAUDE_BIN: z.string().default("claude"),
  MYCEL_STEWARD_MAX_TURNS: z.coerce.number().int().positive().default(8),
  MYCEL_STEWARD_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  MYCEL_STEWARD_MAX_BUDGET_USD: z.coerce.number().positive().default(1),
  MYCEL_EXECUTOR_MAX_TURNS: z.coerce.number().int().positive().default(20),
  MYCEL_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  MYCEL_EXECUTOR_MAX_BUDGET_USD: z.coerce.number().positive().default(5),
  MYCEL_TEST_COMMAND_JSON: z.string().default('["npm","test"]'),
  MYCEL_CLAUDE_MODEL: z.string().optional(),
  DINGTALK_CLIENT_ID: z.string().optional(),
  DINGTALK_CLIENT_SECRET: z.string().optional(),
  DINGTALK_CARD_TEMPLATE_ID: z.string().optional(),
  DINGTALK_ALLOWED_USER_IDS: z.string().optional(),
  DINGTALK_ROBOT_CODE: z.string().optional(),
  DINGTALK_DEBUG: z.enum(["true", "false"]).default("false"),
  MYCEL_FAKE_CONNECTIONS: z.enum(["true", "false"]).default("false"),
});

export interface ServerConfig {
  dataDir: string;
  repositoryPath: string;
  port: number;
  claudeBin: string;
  claudeModel?: string;
  testCommandArgv: string[];
  steward: { maxTurns: number; timeoutMs: number; maxBudgetUsd: number };
  executor: { maxTurns: number; timeoutMs: number; maxBudgetUsd: number };
  dingtalk?: {
    clientId: string;
    clientSecret: string;
    cardTemplateId: string;
    allowedUserIds: string[];
    robotCode: string;
    debug: boolean;
  };
  fakeConnections: boolean;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const env = EnvironmentSchema.parse(environment);
  const testCommand = z.array(z.string().min(1)).min(1).parse(JSON.parse(env.MYCEL_TEST_COMMAND_JSON));
  const dingValues = [
    env.DINGTALK_CLIENT_ID,
    env.DINGTALK_CLIENT_SECRET,
    env.DINGTALK_CARD_TEMPLATE_ID,
    env.DINGTALK_ALLOWED_USER_IDS,
    env.DINGTALK_ROBOT_CODE,
  ];
  const configuredDingValues = dingValues.filter((value) => value && value.trim().length > 0).length;
  if (configuredDingValues > 0 && configuredDingValues < dingValues.length) {
    throw new Error("DingTalk configuration is partial; set all five DINGTALK_* values or leave all empty");
  }
  const dingtalk = configuredDingValues === dingValues.length
    ? {
        clientId: env.DINGTALK_CLIENT_ID!,
        clientSecret: env.DINGTALK_CLIENT_SECRET!,
        cardTemplateId: env.DINGTALK_CARD_TEMPLATE_ID!,
        allowedUserIds: env.DINGTALK_ALLOWED_USER_IDS!.split(",").map((value) => value.trim()).filter(Boolean),
        robotCode: env.DINGTALK_ROBOT_CODE!,
        debug: env.DINGTALK_DEBUG === "true",
      }
    : undefined;
  return {
    dataDir: resolve(cwd, env.MYCEL_DATA_DIR),
    repositoryPath: resolve(cwd, env.MYCEL_TARGET_REPO),
    port: env.MYCEL_PORT,
    claudeBin: env.MYCEL_CLAUDE_BIN,
    ...(env.MYCEL_CLAUDE_MODEL ? { claudeModel: env.MYCEL_CLAUDE_MODEL } : {}),
    testCommandArgv: testCommand,
    steward: {
      maxTurns: env.MYCEL_STEWARD_MAX_TURNS,
      timeoutMs: env.MYCEL_STEWARD_TIMEOUT_MS,
      maxBudgetUsd: env.MYCEL_STEWARD_MAX_BUDGET_USD,
    },
    executor: {
      maxTurns: env.MYCEL_EXECUTOR_MAX_TURNS,
      timeoutMs: env.MYCEL_EXECUTOR_TIMEOUT_MS,
      maxBudgetUsd: env.MYCEL_EXECUTOR_MAX_BUDGET_USD,
    },
    fakeConnections: env.MYCEL_FAKE_CONNECTIONS === "true",
    ...(dingtalk ? { dingtalk } : {}),
  };
}
