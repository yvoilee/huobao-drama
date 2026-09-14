/**
 * 火山引擎 AgentPlan（企业版）视频生成 Adapter
 * 端点: /api/plan/v3/contents/generations/tasks（与普通方舟 Seedance 协议一致，仅前缀不同）
 * 模型为 AgentPlan 命名空间（dot 命名 doubao-seedance-2.0 等），故放宽模型前缀校验。
 */
import { VolcEngineVideoAdapter } from './volcengine-video'

export class AgentPlanVideoAdapter extends VolcEngineVideoAdapter {
  provider = 'agentplan'

  protected apiPrefix = '/api/plan/v3'

  /** AgentPlan 使用 doubao-seedance-2.0 / -fast / -mini（dot 命名），不再强制 2-0-* 短横线前缀 */
  protected modelPrefixes: string[] = ['doubao-seedance']

  protected defaultModel = 'doubao-seedance-2.0'
}
