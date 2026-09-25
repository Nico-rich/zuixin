/** M7-P6 通道常量（core 层定义，避免 modules ↔ worker 循环依赖）：
 * - WORKFLOW_APPROVAL_DECIDED_CHANNEL：API 进程 ApprovalsService.decide 发布；Worker 侧 WorkflowWakeService 订阅；
 * - WORKFLOW_CANCEL_CHANNEL：cancel 快速通道（与 AGENT_RUN_CANCEL_CHANNEL 同构；DB 条件更新仍是唯一事实来源）。 */
export const WORKFLOW_APPROVAL_DECIDED_CHANNEL = 'workflow:approval-decided';
export const WORKFLOW_CANCEL_CHANNEL = 'workflow:cancel';
