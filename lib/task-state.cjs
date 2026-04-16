'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs, findWorkspaceRoot } = require('./core.cjs');
const { loadConfig, requireFeature } = require('./config.cjs');

const TASK_STATE_VERSION = '1.0';
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'failed', 'skipped'];
const TASK_STATUS_SET = new Set(TASK_STATUSES);

function resolveWorkspaceRoot(rootArg) {
  const root = rootArg ? findWorkspaceRoot(rootArg) : findWorkspaceRoot();
  if (!root) error('workspace.yaml not found');
  return root;
}

function getTasksPath(root, featureName) {
  return path.join(root, '.dev', 'features', featureName, 'tasks.json');
}

function defaultTaskState(featureName) {
  return {
    version: TASK_STATE_VERSION,
    feature: featureName,
    updated_at: new Date().toISOString(),
    tasks: [],
  };
}

function normalizeTaskStatus(value, fallback = 'pending') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!TASK_STATUS_SET.has(normalized)) {
    error(`Invalid task status '${value}'. Valid: ${TASK_STATUSES.join(', ')}`);
  }
  return normalized;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || /^none$/i.test(text)) return [];
    const unwrapped = text.replace(/^\[|\]$/g, '');
    return unwrapped
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeDependsOn(value) {
  const list = normalizeStringList(value);
  return list.map(item => String(item));
}

function normalizeTask(task, index) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    error(`Invalid task entry at index ${index}. Expected an object.`);
  }
  return {
    id: String(task.id || index + 1),
    title: String(task.title || '').trim(),
    repo: task.repo ? String(task.repo).trim() : null,
    dev_worktree: task.dev_worktree ? String(task.dev_worktree).trim() : null,
    files_to_modify: normalizeStringList(task.files_to_modify),
    files_to_read: normalizeStringList(task.files_to_read),
    depends_on: normalizeDependsOn(task.depends_on),
    wave: Number.isFinite(Number(task.wave)) ? Number(task.wave) : 1,
    status: normalizeTaskStatus(task.status, 'pending'),
    commit: task.commit ? String(task.commit).trim() : null,
    notes: task.notes ? String(task.notes).trim() : null,
  };
}

function normalizeTaskStatePayload(featureName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    error('tasks.json payload must be an object.');
  }
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return {
    version: payload.version || TASK_STATE_VERSION,
    feature: payload.feature || featureName,
    updated_at: payload.updated_at || new Date().toISOString(),
    tasks: tasks.map((task, index) => normalizeTask(task, index)),
  };
}

function writeTaskState(root, featureName, payload) {
  const tasksPath = getTasksPath(root, featureName);
  const normalized = normalizeTaskStatePayload(featureName, {
    ...payload,
    feature: featureName,
    updated_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return { path: tasksPath, state: normalized };
}

function readTaskState(root, featureName) {
  const tasksPath = getTasksPath(root, featureName);
  if (!fs.existsSync(tasksPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  } catch (e) {
    error(`Failed to parse tasks.json for feature '${featureName}': ${e.message}`);
  }
  return normalizeTaskStatePayload(featureName, parsed);
}

function summarizeTaskState(taskState) {
  const counts = {};
  for (const status of TASK_STATUSES) counts[status] = 0;
  const tasks = taskState && Array.isArray(taskState.tasks) ? taskState.tasks : [];
  for (const task of tasks) {
    const status = normalizeTaskStatus(task.status, 'pending');
    counts[status] += 1;
  }
  const total = tasks.length;
  const completed = counts.completed;
  const remaining = tasks.filter(task => {
    const status = normalizeTaskStatus(task.status, 'pending');
    return status !== 'completed' && status !== 'skipped';
  }).length;
  const nextTask = tasks.find(task => task.status !== 'completed' && task.status !== 'skipped') || null;
  return {
    total_tasks: total,
    completed_tasks: completed,
    remaining_tasks: remaining,
    by_status: counts,
    next_task: nextTask ? { id: nextTask.id, title: nextTask.title, status: nextTask.status } : null,
  };
}

function parseListField(value) {
  const normalized = normalizeStringList(value);
  return normalized;
}

function parseDependsOnField(value) {
  const text = String(value || '').trim();
  if (!text || /^none$/i.test(text)) return [];
  const unwrapped = text.replace(/^\[|\]$/g, '');
  return unwrapped
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => String(item).replace(/^Task\s+/i, ''));
}

function finalizeParsedTask(task) {
  return {
    id: String(task.id),
    title: task.title || '',
    repo: task.repo || null,
    dev_worktree: task.dev_worktree || null,
    files_to_modify: parseListField(task.files_to_modify || ''),
    files_to_read: parseListField(task.files_to_read || ''),
    depends_on: parseDependsOnField(task.depends_on || ''),
    wave: task.wave || 1,
    status: normalizeTaskStatus(task.status || 'pending'),
    commit: task.commit || null,
    notes: task.notes || null,
  };
}

function parsePlanTasks(planPath) {
  if (!fs.existsSync(planPath)) {
    error(`plan.md not found at '${planPath}'`);
  }
  const lines = fs.readFileSync(planPath, 'utf8').split('\n');
  const tasks = [];
  let currentWave = 1;
  let currentTask = null;

  function flushCurrentTask() {
    if (!currentTask) return;
    tasks.push(finalizeParsedTask(currentTask));
    currentTask = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const waveMatch = line.match(/^##\s+Wave\s+(\d+)/i);
    if (waveMatch) {
      currentWave = Number(waveMatch[1]) || currentWave;
      continue;
    }

    const taskMatch = line.match(/^###\s+Task\s+([0-9A-Za-z._-]+)\s*:\s*(.+)$/);
    if (taskMatch) {
      flushCurrentTask();
      currentTask = {
        id: String(taskMatch[1]),
        title: taskMatch[2].trim(),
        wave: currentWave,
      };
      continue;
    }

    if (!currentTask) continue;
    const fieldMatch = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
    if (!fieldMatch) continue;

    const field = fieldMatch[1].trim().toLowerCase();
    const value = fieldMatch[2].trim();
    if (field === 'repo') currentTask.repo = value;
    else if (field === 'worktree') currentTask.dev_worktree = value;
    else if (field === 'files to modify') currentTask.files_to_modify = value;
    else if (field === 'files to read') currentTask.files_to_read = value;
    else if (field === 'depends on') currentTask.depends_on = value;
    else if (field === 'status') currentTask.status = value;
    else if (field === 'notes') currentTask.notes = value;
  }

  flushCurrentTask();
  return tasks;
}

function ensureTaskState(root, featureName) {
  const existing = readTaskState(root, featureName);
  if (existing) return { created: false, state: existing, path: getTasksPath(root, featureName) };
  const written = writeTaskState(root, featureName, defaultTaskState(featureName));
  return { created: true, state: written.state, path: written.path };
}

function updateTask(root, featureName, options = {}) {
  const existing = readTaskState(root, featureName);
  if (!existing) {
    error(`tasks.json not found for feature '${featureName}'. Run 'tasks init' or 'tasks sync-from-plan' first.`);
  }
  if (!options.id) error('--id is required for tasks update');
  const id = String(options.id);
  const tasks = existing.tasks.map(task => ({ ...task }));
  const task = tasks.find(item => String(item.id) === id);
  if (!task) {
    error(`Task '${id}' not found in tasks.json for feature '${featureName}'.`);
  }

  if (options.status != null) task.status = normalizeTaskStatus(options.status);
  if (options.commit != null) task.commit = String(options.commit || '').trim() || null;
  if (options.notes != null) task.notes = String(options.notes || '').trim() || null;
  if (options.title != null) task.title = String(options.title || '').trim();

  const written = writeTaskState(root, featureName, {
    ...existing,
    tasks,
  });
  return {
    action: 'update',
    feature: featureName,
    task,
    summary: summarizeTaskState(written.state),
    path: written.path,
  };
}

function syncTasksFromPlan(root, featureName, planPathArg) {
  const planPath = planPathArg || path.join(root, '.dev', 'features', featureName, 'plan.md');
  const tasks = parsePlanTasks(planPath);
  const written = writeTaskState(root, featureName, {
    version: TASK_STATE_VERSION,
    feature: featureName,
    tasks,
  });
  return {
    action: 'sync-from-plan',
    feature: featureName,
    plan_path: planPath,
    path: written.path,
    summary: summarizeTaskState(written.state),
    task_count: written.state.tasks.length,
  };
}

function getTaskStateResult(root, featureName) {
  const state = readTaskState(root, featureName);
  if (!state) {
    return {
      feature: featureName,
      path: getTasksPath(root, featureName),
      exists: false,
      task_state: null,
      summary: summarizeTaskState(null),
    };
  }
  return {
    feature: featureName,
    path: getTasksPath(root, featureName),
    exists: true,
    task_state: state,
    summary: summarizeTaskState(state),
  };
}

function resetTaskState(root, featureName) {
  const tasksPath = getTasksPath(root, featureName);
  const existed = fs.existsSync(tasksPath);
  if (existed) fs.unlinkSync(tasksPath);
  return {
    action: 'reset',
    feature: featureName,
    path: tasksPath,
    removed: existed,
  };
}

function handleTaskState(subcommand, args) {
  const parsed = parseArgs(args || []);
  const root = resolveWorkspaceRoot(parsed.root || null);
  const config = loadConfig(root);
  const feature = requireFeature(config, parsed.feature || null);
  const featureName = feature.name;

  let result;
  switch (subcommand) {
    case 'init': {
      const ensured = ensureTaskState(root, featureName);
      result = {
        action: 'init',
        feature: featureName,
        created: ensured.created,
        path: ensured.path,
        task_state: ensured.state,
        summary: summarizeTaskState(ensured.state),
      };
      break;
    }
    case 'get':
      result = getTaskStateResult(root, featureName);
      break;
    case 'summary': {
      const got = getTaskStateResult(root, featureName);
      result = {
        feature: featureName,
        path: got.path,
        exists: got.exists,
        summary: got.summary,
      };
      break;
    }
    case 'sync-from-plan':
      result = syncTasksFromPlan(root, featureName, parsed.plan || null);
      break;
    case 'update':
      result = updateTask(root, featureName, {
        id: parsed.id || null,
        status: parsed.status,
        commit: parsed.commit,
        notes: parsed.notes,
        title: parsed.title,
      });
      break;
    case 'reset':
      result = resetTaskState(root, featureName);
      break;
    default:
      error(`Unknown tasks subcommand: '${subcommand}'. Use: init, get, summary, sync-from-plan, update, reset`);
  }

  output(result);
}

module.exports = {
  TASK_STATE_VERSION,
  TASK_STATUSES,
  getTasksPath,
  defaultTaskState,
  normalizeTaskStatus,
  normalizeTask,
  normalizeTaskStatePayload,
  writeTaskState,
  readTaskState,
  summarizeTaskState,
  parsePlanTasks,
  ensureTaskState,
  updateTask,
  syncTasksFromPlan,
  getTaskStateResult,
  resetTaskState,
  handleTaskState,
};
