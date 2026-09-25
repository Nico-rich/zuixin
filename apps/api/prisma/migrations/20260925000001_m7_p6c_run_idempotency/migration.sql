-- M7-P6c：WorkflowRun 触发幂等（部分唯一索引：仅 attempt=1 的首发去重；retry 不冲突）
CREATE UNIQUE INDEX "WorkflowRun_workflowId_idempotencyKey_attempt1_key"
  ON "WorkflowRun" ("workflowId", "idempotencyKey")
  WHERE "attempt" = 1;
