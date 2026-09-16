# MCP Server 配置文档

## 概述

`agentfeed-knowledge` 是一个基于 MCP 的本地知识看板服务。它以 stdio 方式运行，供 Trae / Claude Desktop / Cursor 等 agent 直接挂载，搜索并读取本地 wiki 知识。

## 启动方式

```bash
cd server && npm run mcp
```

该命令会启动一个 stdio MCP server，并通过标准输入输出进行 JSON-RPC 通信。

## 配置示例

### Trae

在 Trae 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agentfeed-knowledge": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "<AgentFeed 仓库路径>/server"
    }
  }
}
```

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "agentfeed-knowledge": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "<AgentFeed 仓库路径>/server"
    }
  }
}
```

### Cursor

在 Cursor 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "agentfeed-knowledge": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "<AgentFeed 仓库路径>/server"
    }
  }
}
```

## 已暴露工具

| 工具名 | 说明 |
| --- | --- |
| `search_knowledge` | 按 query / domain / tags / agent 搜索知识条目 |
| `read_entry` | 按 file id 读取 wiki 条目 markdown |
| `get_source` | 按 file id 获取原始文件绝对路径 |
| `list_domains` | 列出所有知识领域 |
| `list_agents` | 列出所有 source agent |
| `list_tags` | 列出所有标签 |
| `stats` | 获取知识库基础统计 |

## 验证

配置完成后，可在 agent 中先调用 `stats` 验证连接是否正常：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "stats",
    "arguments": {}
  }
}
```

## 备注

- 该 server 仅通过 stdio 通信，不暴露 HTTP 端口。
- 数据目录默认为 `server/data`。
- 如需修改启动脚本，请编辑 `server/package.json` 中的 `mcp` 字段。
