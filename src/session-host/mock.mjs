import { normalize } from '../workspace/catalog.mjs';

export const HELP = '这是模拟宿主，没有调用模型。可发送 /read notes.txt、/list、/search 关键字、/append notes.txt 内容、/build、/long 或 /run 命令。任务固定在当前会话绑定的本地项目内执行；权限由本地选择。';
export function parseMock(input, snapshot) {
  const [command, ...parts] = input.trim().split(/\s+/), rest = parts.join(' ');
  let tool, args;
  if (command === '/read' && parts.length === 1) { tool = 'workspace_read_file'; args = { path: rest }; }
  else if (command === '/list' && parts.length <= 1) { tool = 'workspace_list_directory'; args = { path: rest || '.', depth: 2 }; }
  else if (command === '/search' && rest) { tool = 'workspace_search'; args = { path: '.', pattern: rest, literal: true }; }
  else if (command === '/append' && parts.length >= 2) {
    const path = parts.shift(), version = snapshot(path); if (!version) throw Error('READ_FILE_BEFORE_EDIT');
    tool = 'workspace_write_file'; args = { path, content: parts.join(' ') + '\n', mode: 'append', expectedRevision: version };
  } else if (command === '/build' && !rest) { tool = 'workspace_run'; args = { command: 'node build.mjs && node --test test.mjs' }; }
  else if (command === '/long' && !rest) { tool = 'workspace_run'; args = { command: 'node long.mjs' }; }
  else if (command === '/run' && rest) { tool = 'workspace_run'; args = { command: rest }; }
  else return { help: HELP };
  normalize(tool, args); return { tool, args };
}
