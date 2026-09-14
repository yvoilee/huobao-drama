/**
 * 火山引擎 AgentPlan（企业版）图片生成 Adapter
 * 端点: /api/plan/v3/images/generations（与普通方舟图片协议一致，仅前缀不同）
 * 模型与普通方舟相同（doubao-seedream-*），仅替换接口前缀。
 */
import { VolcEngineImageAdapter } from './volcengine-image'

export class AgentPlanImageAdapter extends VolcEngineImageAdapter {
  provider = 'agentplan'

  protected apiPrefix = '/api/plan/v3'

  /** AgentPlan 生图模型为 dot 命名（doubao-seedream-5.0-lite 等） */
  protected defaultModel = 'doubao-seedream-5.0-lite'
}
