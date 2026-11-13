// MCP 接口（HTTP JSON-RPC）：让本机 AI（Claude Code / Cursor / 自研 agent）直接管理服务器
// 仅监听 127.0.0.1，POST /mcp；实现 initialize / tools/list / tools/call / ping
import * as http from 'http';
import * as path from 'path';
import { app } from 'electron';
import { runDoctor } from './doctor';
import {
  forceStopServer,
  listStatuses,
  readLogTail,
  sendCommand,
  startServer,
  stopServer,
} from './servers';
import { deleteServerMod, installServerMod, listServerMods, searchServerMods } from './serverMods';

const DEFAULT_PORT = 18998;
const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpc {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'list_servers',
    description: '列出本机所有 1b1t 服务器（目录、版本、类型、端口、是否运行、在线人数）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'server_status',
    description: '查询单个服务器状态',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
  {
    name: 'start_server',
    description: '启动服务器（后台运行，约 2 秒返回）',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
  {
    name: 'stop_server',
    description: '优雅关服（保存世界后退出）',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
  {
    name: 'force_stop_server',
    description: '强制结束进程（不保存世界，慎用）',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
  {
    name: 'send_command',
    description: '向服务器控制台发送命令（如 list / say hi / save-all）',
    inputSchema: {
      type: 'object',
      required: ['dir', 'cmd'],
      properties: { dir: { type: 'string' }, cmd: { type: 'string' } },
    },
  },
  {
    name: 'read_log',
    description: '读取服务器最近日志（默认最后 200 行）',
    inputSchema: {
      type: 'object',
      required: ['dir'],
      properties: { dir: { type: 'string' }, lines: { type: 'integer', default: 200 } },
    },
  },
  {
    name: 'run_doctor',
    description: '运行自检（Java/端口/核心文件/EULA/磁盘/权限/内存/模组/日志 九项）',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
  {
    name: 'search_mods',
    description: '在 Modrinth 搜索模组或插件（按服务器 MC 版本/加载器过滤）',
    inputSchema: {
      type: 'object',
      required: ['dir', 'query'],
      properties: {
        dir: { type: 'string' },
        query: { type: 'string' },
        type: { type: 'string', enum: ['mod', 'plugin'], default: 'mod' },
      },
    },
  },
  {
    name: 'install_mod',
    description: '安装模组/插件到服务器（自动装必需依赖）',
    inputSchema: {
      type: 'object',
      required: ['dir', 'project'],
      properties: {
        dir: { type: 'string' },
        project: { type: 'string' },
        type: { type: 'string', enum: ['mod', 'plugin'], default: 'mod' },
        versionId: { type: 'string' },
      },
    },
  },
  {
    name: 'list_mods',
    description: '列出服务器已装的模组与插件',
    inputSchema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } },
  },
];

function textResult(obj: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
    isError,
  };
}

function resolveDir(raw: string): string {
  if (!raw) return '';
  if (raw.startsWith('~')) return path.join(app.getPath('home'), raw.slice(1));
  return path.resolve(raw);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dir = resolveDir(String(args.dir ?? ''));
  const type = (String(args.type ?? 'mod') === 'plugin' ? 'plugin' : 'mod') as 'mod' | 'plugin';
  switch (name) {
    case 'list_servers': {
      const list = await listStatuses();
      return textResult(list);
    }
    case 'server_status': {
      const list = await listStatuses();
      const hit = list.find((s) => s.dir === dir);
      return hit ? textResult(hit) : textResult({ error: '未找到服务器: ' + dir }, true);
    }
    case 'start_server': {
      const r = await startServer(dir, () => undefined);
      return textResult(r, !r.ok);
    }
    case 'stop_server': {
      const r = await stopServer(dir, () => undefined);
      return textResult(r, !r.ok);
    }
    case 'force_stop_server': {
      const r = await forceStopServer(dir, () => undefined);
      return textResult(r, !r.ok);
    }
    case 'send_command': {
      const r = sendCommand(dir, String(args.cmd ?? ''));
      return textResult(r, !r.ok);
    }
    case 'read_log': {
      const n = Number(args.lines ?? 200) || 200;
      const chunk = readLogTail(dir, 256 * 1024);
      const lines = chunk.lines.split('\n').filter((l) => l.length > 0);
      return textResult(lines.slice(-n).join('\n'));
    }
    case 'run_doctor': {
      return textResult(await runDoctor(dir));
    }
    case 'search_mods': {
      const r = await searchServerMods(dir, String(args.query ?? ''), type, 0);
      return textResult(r);
    }
    case 'install_mod': {
      const r = await installServerMod(dir, String(args.project ?? ''), type, String(args.versionId ?? ''));
      return textResult(r, !r.ok);
    }
    case 'list_mods': {
      return textResult(listServerMods(dir));
    }
    default:
      return textResult({ error: '未知工具: ' + name }, true);
  }
}

async function handleRpc(msg: JsonRpc): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: '1b1t-server', version: app.getVersion() },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = params.name ?? '';
    try {
      const result = await callTool(name, params.arguments ?? {});
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: textResult(e instanceof Error ? e.message : String(e), true) };
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method },
  };
}

export interface McpInfo {
  url: string;
  running: boolean;
  error: string;
}

let info: McpInfo = { url: '', running: false, error: '' };

export function getMcpInfo(): McpInfo {
  return info;
}

/** 启动 MCP HTTP 服务（只监听本机回环地址） */
export function startMcpServer(): McpInfo {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: app.getVersion() }));
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c.toString('utf-8');
      if (body.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let msg: JsonRpc;
      try {
        msg = JSON.parse(body) as JsonRpc;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      void handleRpc(msg)
        .then((out) => {
          if (!out) {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        })
        .catch((e: unknown) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id ?? null,
              error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
            }),
          );
        });
    });
  });
  const tryListen = (port: number): void => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && port < DEFAULT_PORT + 5) {
        tryListen(port + 1);
        return;
      }
      info = { url: '', running: false, error: e.message };
      console.error('[mcp] start failed: ' + e.message);
    });
    server.listen(port, '127.0.0.1', () => {
      info = { url: 'http://127.0.0.1:' + port + '/mcp', running: true, error: '' };
      console.log('[mcp] listening on ' + info.url);
    });
  };
  tryListen(DEFAULT_PORT);
  return info;
}
