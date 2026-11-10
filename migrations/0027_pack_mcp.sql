-- A pack's MCP calls (#488): allowed or not, beside its level. Its jobs are rows in pack_ai_calls with kind 'mcp': when, cost, whether; never a call or a result.
ALTER TABLE pack_ai ADD COLUMN mcp INTEGER NOT NULL DEFAULT 0;
