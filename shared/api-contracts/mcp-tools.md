# HomeHub MCP server

Endpoint: `…/mcp` (Streamable HTTP, stateless, JSON responses). Callers: server Hermes (`Authorization: Bearer <HOMEHUB_MCP_SERVICE_KEY>`) or Hermes Mobile (`Authorization: Bearer <user Firebase ID token>`).
Every tool requires `grant` (per-run capability, bound to one user + household, expires, call-capped). No tool accepts a household ID.
Results: `{"ok":true,"data":…}` · `{"ok":false,"status":"approval_required","approvalId":…}` · `{"ok":false,"error":{"code","message"}}`. Amounts are integer minor units.

Household: get_household_summary · get_household_members · get_member_permissions
Tasks: list_tasks · create_task · update_task · complete_task · assign_task
Shopping: get_inventory · get_low_stock_items · create_shopping_list · add_shopping_item · mark_item_purchased
Meals: get_meal_plan · create_meal_plan · generate_meal_shopping_list
Finance: get_budget_summary · list_expenses · record_expense · get_bill_status
Maintenance: list_maintenance_records · create_maintenance_request · schedule_service_reminder
Calendar: list_events · create_event · check_schedule_conflicts
Approvals: request_approval · list_pending_approvals · get_approval_status
Reports: get_household_report · get_agent_usage_report

Risk classes (`src/mcp/tools.ts`): read → always allowed; reversible writes → automatic in routine/advanced; bounded writes (meal plan, expense record, purchase marking) → approval in routine; sensitive kinds → always approval. Pause denies all writes.
