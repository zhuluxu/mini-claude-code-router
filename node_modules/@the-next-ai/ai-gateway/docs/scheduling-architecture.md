# Gateway 调度架构设计

本文描述下一阶段 gateway 调度能力的目标架构。设计参考 CCR 的规则路由、多凭证调度和 fallback 经验，但不照搬 CCR 的本地 wrapper 架构；gateway 应把能力内聚到核心请求路径中。

## 设计目标

- 支持按请求特征选择逻辑模型，例如长上下文、图片、thinking、工具、租户、header/body 条件。
- 支持同一供应商多 API key 调度，包括优先级、权重、限额、冷却、故障切换。
- 支持缓存亲和调度，避免不必要地跨供应商或跨账号导致 prompt cache 失效。
- 支持可解释的 fallback 链路，返回最终命中的 provider/model/key 和失败尝试信息。
- 保持现有 adapter、provider plugin、policy、precheck、health、circuit breaker 的边界清晰。

## 当前实现范围

当前代码已落地 Phase 1 和 Phase 2 的核心路径：`ProviderConfig.credentials[]` 展开、凭证级优先级/权重/限额/冷却、基于请求身份和稳定 body hash 的内存缓存亲和、成功响应 usage 对缓存亲和的反哺、调度响应头，以及 `fallback.maxAttempts` 对尝试链长度的限制。

本文中规则路由、分阶段 fallback、`Retry-After` 等待、多 protocol capability、调度指标和完整可解释 attempt 明细仍属于后续阶段，不在本次实现中默认启用。

## 是否需要路由层

需要，但路由层不应该直接做 provider/API key 选择。它的职责是把请求映射到一个逻辑目标和 fallback 策略：

- 逻辑目标：`logicalModel` 或 `provider/model`。
- 请求改写：可选地修改 request body/header，例如模型名、工具参数、reasoning 参数。
- fallback 策略：本条规则失败时允许怎样降级。

不建议把 provider 健康、API key 额度、缓存亲和、熔断状态揉进路由规则。否则规则会很难解释，也很难复用当前 gateway 已有的 health-aware routing、policy 和 circuit breaker。

推荐分层：

```text
source adapter
  -> logical route resolver        // 选择逻辑模型和规则级 fallback
  -> candidate planner             // 展开 provider/capability/credential 候选
  -> scheduler scorer              // 健康、成本、限额、缓存亲和打分
  -> attempt executor              // 按候选链尝试并记录结果
  -> target adapter / upstream
```

## 核心概念

### 逻辑模型

逻辑模型是客户端看到或业务配置使用的模型名，可以直接映射到一个或多个实际候选。

```ts
interface LogicalModelRoute {
  id: string;
  match: {
    model?: string;
    prefixes?: string[];
    suffixes?: string[];
    aliases?: string[];
  };
  targets: ScheduledTarget[];
  fallback?: SchedulingFallbackConfig;
}
```

### 供应商能力

当前 `ProviderConfig.type` 同时表达供应商类别和上游协议。未来建议允许一个逻辑 provider 声明多个 capability，便于同一个服务同时支持 OpenAI Chat、OpenAI Responses、Anthropic Messages 等协议。

```ts
interface ProviderCapabilityConfig {
  type: ProviderType;
  baseurl?: string;
  models?: string[];
  extraHeaders?: ModelScopedHeadersConfig;
  extraBody?: ModelScopedBodyConfig;
}
```

如果没有 `capabilities`，沿用现有 `ProviderConfig.type/baseurl/models`。

### 凭证

一个 provider 可以配置多把 API key。调度时每把 key 都是一个可独立限流、冷却、统计、缓存亲和的候选。

```ts
interface ProviderCredentialConfig {
  id: string;
  apikey?: string;
  apiKeyEnv?: string;
  enabled: boolean;
  priority: number;
  weight: number;
  limits?: {
    rpm?: number;
    tpm?: number;
    rpd?: number;
    tpd?: number;
    ipm?: number;
  };
  cache?: ProviderCacheConfig;
}
```

### 调度候选

一次请求会展开成多个候选。候选粒度应该到 credential，因为缓存、限额、冷却通常都和 key 或账号相关。

```ts
interface SchedulingCandidate {
  provider: Provider;
  providerName: string;
  providerType: ProviderType;
  model: string;
  credentialId?: string;
  cacheScopeKey: string;
  priority: number;
  weight: number;
  fallbackStage: SchedulingFallbackStage;
}
```

## 缓存亲和

切换供应商或账号后，上游 prompt cache 通常不可复用。因此缓存亲和必须成为调度的一等信号。

### Cache Scope

cache scope 描述缓存最可能共享的边界：

```ts
type ProviderCacheScope =
  | 'provider'
  | 'provider_model'
  | 'credential'
  | 'credential_model';

interface ProviderCacheConfig {
  enabled: boolean;
  scope: ProviderCacheScope;
  ttlMs: number;
  minPrefixTokens: number;
  maxWaitMs: number;
}
```

默认建议：

- `scope = credential_model`
- `ttlMs = 10 * 60_000`
- `minPrefixTokens = 1024`
- `maxWaitMs = 3000`

不要默认假设同 provider 的多把 key 可以共享缓存。

### Affinity Key

gateway 不保存原始 prompt，只保存稳定前缀 hash 和绑定关系。

```ts
interface CacheAffinityBinding {
  key: string;
  providerName: string;
  model: string;
  credentialId?: string;
  cacheScopeKey: string;
  lastHitAt: number;
  expiresAt: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

`key` 推荐由以下字段组成：

```text
tenantId/userId/sessionId/logicalModel/stablePrefixHash
```

`stablePrefixHash` 应只基于稳定内容：

- system prompt
- tools schema
- developer/config messages
- 历史消息稳定前缀

没有 sessionId 时，允许客户端传 `x-gateway-cache-affinity-key`。仍然没有时，仅做弱缓存亲和，不创建强绑定。

### 缓存更新

成功响应后，如果 usage 中包含 cache read/write 信息，则更新 binding：

- 有 cache write：绑定本次候选。
- 有 cache read：刷新已有 binding 的 `lastHitAt/expiresAt`。
- 没有 cache 字段但请求满足 `minPrefixTokens`：可创建低置信度 binding，后续被真实 cache usage 校正。

## API Key 调度

API key 调度应结合优先级、权重、限额、冷却和缓存亲和。

排序建议：

1. 缓存亲和命中的 credential。
2. 未 cooldown 且未超限的 credential。
3. `priority` 小者优先。
4. 同 priority 下，限额利用率低者优先。
5. 同利用率下，使用 smooth weighted round-robin，而不是简单按 weight 排序。
6. 如果主优先级 credential 利用率都超过 spillover 阈值，例如 80%，允许溢出到下一优先级。

状态结构：

```ts
interface CredentialRuntimeState {
  inFlight: number;
  cooldownUntil?: number;
  consecutiveFailures: number;
  currentWeight: number;
  windowCounters: Record<string, number>;
}
```

冷却触发建议：

- `401/403`：较长冷却，默认 5 分钟，可配置为直接禁用直到健康检查恢复。
- `429`：遵守 `Retry-After`，否则默认 60 秒。
- `5xx` 或网络错误：短冷却，默认 30-60 秒，并计入熔断。

## Fallback 策略

调度 fallback 不应只有“下一个 provider”。建议分阶段：

```ts
type SchedulingFallbackStage =
  | 'same_credential_retry'
  | 'same_provider_same_cache_scope'
  | 'same_provider_other_credential'
  | 'same_provider_other_model'
  | 'model_chain'
  | 'cross_provider';

interface SchedulingFallbackConfig {
  mode: 'off' | 'retry' | 'model_chain' | 'provider_chain' | 'adaptive';
  maxAttempts: number;
  retryStatusCodes: number[];
  crossProviderStatusCodes: number[];
  preserveCache: 'prefer' | 'strict' | 'off';
  maxCacheWaitMs: number;
  models: string[];
  providers: string[];
}
```

推荐默认顺序：

```text
1. same_credential_retry
2. same_provider_same_cache_scope
3. same_provider_other_credential
4. same_provider_other_model
5. model_chain
6. cross_provider
```

`429` 的特殊处理：

```text
如果存在缓存亲和，并且 Retry-After <= maxCacheWaitMs:
  等待后重试原 cache scope
否则:
  先尝试同 provider 其他 credential
  再按配置考虑跨 provider
```

长上下文或高 cache write 成本请求应更保守，跨 provider 的惩罚更高。

## 打分模型

调度器先过滤不可用候选，再计算 score，分数越低越优。

```text
score =
  priorityPenalty
+ healthPenalty
+ circuitBreakerPenalty
+ rateLimitPenalty
+ concurrencyPenalty
+ latencyPenalty
+ costPenalty
+ fallbackStagePenalty
- cacheAffinityBonus
+ weightedRoundRobinOffset
+ jitter
```

建议默认权重：

- cache affinity：强 bonus，足以压过轻微延迟/成本差异。
- health/circuit breaker：硬过滤优先，不能只靠分数。
- cross provider：高 penalty，除非当前 provider 明确失败或策略允许。
- cost：可配置，默认低于缓存亲和和健康。

## 请求流程

```ts
async function handleScheduledGatewayRequest(input: GatewayRequestInput) {
  const standardRequest = await sourceAdapter.toStandardRequest(input);
  const route = resolveLogicalRoute(standardRequest, input);
  const cacheKey = computeCacheAffinityKey(route, standardRequest, input.identity);
  const cacheBinding = cacheAffinityStore.get(cacheKey);

  let candidates = planSchedulingCandidates(route, standardRequest, input.config);
  candidates = applyPolicyAndPrecheck(candidates, input);
  candidates = rankCandidates(candidates, {
    cacheBinding,
    health: providerHealthStore,
    credentialState: credentialScheduler,
    circuitBreaker: upstreamCircuitBreaker
  });

  const attempts: SchedulingAttempt[] = [];
  for (const candidate of candidates) {
    const result = await executeCandidate(candidate, standardRequest, input);
    attempts.push(result.attempt);

    updateRuntimeState(candidate, result);

    if (result.ok) {
      updateCacheAffinity(cacheKey, candidate, result.usage);
      attachSchedulingHeaders(input.reply, candidate, attempts);
      return result.response;
    }

    if (!shouldContinueScheduling(result, attempts, route.fallback)) {
      break;
    }

    candidates = rerankRemainingCandidates(candidates, {
      failedCandidate: candidate,
      failure: result.failure,
      cacheBinding
    });
  }

  return buildSchedulingFailure(attempts);
}
```

## 配置示例

```json
{
  "scheduling": {
    "enabled": true,
    "cacheAffinity": {
      "enabled": true,
      "store": "memory",
      "ttlMs": 600000,
      "defaultScope": "credential_model",
      "minPrefixTokens": 1024,
      "maxWaitMs": 3000
    },
    "credentialScheduler": {
      "enabled": true,
      "spilloverUtilization": 0.8,
      "cooldownMs": {
        "auth": 300000,
        "rateLimit": 60000,
        "serverError": 60000,
        "network": 30000
      }
    },
    "fallback": {
      "mode": "adaptive",
      "maxAttempts": 4,
      "retryStatusCodes": [408, 409, 429, 500, 502, 503, 504],
      "crossProviderStatusCodes": [401, 403, 404, 429, 500, 502, 503, 504],
      "preserveCache": "prefer",
      "maxCacheWaitMs": 3000
    }
  },
  "Providers": [
    {
      "name": "openai-main",
      "type": "openai_responses",
      "baseurl": "https://api.openai.com/v1",
      "models": ["gpt-5.1"],
      "cache": {
        "enabled": true,
        "scope": "credential_model",
        "ttlMs": 600000,
        "minPrefixTokens": 1024
      },
      "credentials": [
        {
          "id": "openai-a",
          "apiKeyEnv": "OPENAI_KEY_A",
          "priority": 1,
          "weight": 3,
          "limits": {
            "rpm": 3000,
            "tpm": 500000
          }
        },
        {
          "id": "openai-b",
          "apiKeyEnv": "OPENAI_KEY_B",
          "priority": 1,
          "weight": 1,
          "limits": {
            "rpm": 3000,
            "tpm": 500000
          }
        }
      ]
    }
  ],
  "routing": {
    "logicalRoutes": [
      {
        "id": "long-context",
        "enabled": true,
        "condition": {
          "left": "request.tokenCount",
          "operator": ">",
          "right": "200000"
        },
        "target": "openai-main/gpt-5.1",
        "fallback": {
          "mode": "adaptive",
          "models": ["anthropic-main/claude-sonnet-4-5"],
          "preserveCache": "prefer"
        }
      }
    ]
  }
}
```

## 响应头与观测

成功响应建议增加：

- `x-gateway-scheduled-provider`
- `x-gateway-scheduled-provider-name`
- `x-gateway-scheduled-model`
- `x-gateway-scheduled-credential-id`
- `x-gateway-cache-affinity`：`hit|miss|bypass|updated`
- `x-gateway-fallback-used`
- `x-gateway-fallback-count`
- `x-gateway-fallback-stages`
- `x-gateway-fallback-failures`

Prometheus 指标：

- `gateway_scheduler_attempts_total{provider_name,credential_id,stage,outcome}`
- `gateway_scheduler_cache_affinity_total{outcome}`
- `gateway_scheduler_credential_cooldown_total{reason}`
- `gateway_scheduler_candidate_score{provider_name,credential_id}`
- `gateway_scheduler_fallback_total{from_provider,to_provider,stage}`

## 与现有模块的关系

- `policy`：在候选展开后过滤 provider/providerName/model/credential。
- `precheck`：先按请求身份做全局治理，再按候选做 provider/model/key 维度治理。
- `health-routing`：升级为 scheduler 的 health score 或硬过滤输入。
- `upstream-concurrency`：从 provider 维度扩展到 providerName/credential 维度。
- `upstream-circuit-breaker`：从 provider/providerName 扩展到 credential 可选维度。
- `billing`：记录最终候选，也记录 fallback attempts；cache read/write 用量反哺 cache affinity。
- `providerPlugins`：按最终候选的 providerName/credential 执行。credential 不应暴露给插件修改，除非显式支持 credential-scoped plugin。

## 落地阶段

### Phase 1：凭证调度

- 扩展 `ProviderConfig.credentials[]`。
- 将 credential 展开为内部候选。
- 支持 priority、weight、limits、cooldown。
- 响应头和指标暴露 credential chain。

### Phase 2：缓存亲和

- 实现内存版 `CacheAffinityStore`。
- 从 request identity/session/prefix hash 生成 affinity key。
- 从 usage cache read/write 更新 binding。
- 调度打分加入 cache affinity。

### Phase 3：规则路由

- 增加 `logicalRoutes`。
- 支持 condition、long-context、image、thinking、web-search、model-prefix。
- 支持规则级 fallback。

### Phase 4：自适应 fallback

- 实现 fallback stage。
- 支持 `Retry-After` + `maxCacheWaitMs`。
- 支持按失败原因 rerank 候选。

### Phase 5：Provider capabilities

- 支持一个逻辑 provider 多协议 capability。
- 根据入站协议和 target adapter 能力选择 capability。
- 对外保留稳定 providerName，对内使用 capability/credential 细分名称。

## 需要避免的问题

- 不要把路由规则写成脚本执行作为默认能力。服务端任意代码执行风险高，除非只在本地单用户模式启用。
- 不要默认跨 provider fallback。长上下文请求切到其他 provider 会丢缓存，可能更慢也更贵。
- 不要把 weight 当简单排序。需要真正的 smooth weighted round-robin，否则大权重 key 会长期抢占。
- 不要保存原始 prompt 做缓存亲和。只保存 hash 和统计元数据。
- 不要把 provider health 和 credential health 混在一起。provider 可用不代表某把 key 可用，某把 key 限流也不代表 provider 整体不可用。
