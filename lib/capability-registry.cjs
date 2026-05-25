'use strict';

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig, normalizeStringList } = require('./workspace-config.cjs');
const { resolveTrackSelection } = require('./track-resolver.cjs');

function sortedEntries(map) {
  return Object.entries(map || {}).sort(([left], [right]) => left.localeCompare(right));
}

function compactInstance(name, instance) {
  return {
    name,
    track: instance.track || null,
    feat: instance.feat || null,
    capability: instance.capability || null,
    environment: instance.environment || null,
    maturity: instance.maturity || null,
  };
}

function environmentList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  return {
    action: 'environment_list',
    workspace: config.root,
    environments: sortedEntries(config.environments).map(([name, env]) => ({
      name,
      kind: env.kind || 'unknown',
      status: env.status || null,
      ssh: env.ssh || env.entry_ssh || (env.entry && env.entry.ssh) || null,
      registry: env.registry || null,
      nodes: Array.isArray(env.nodes) ? env.nodes.length : 0,
    })),
  };
}

function environmentShow(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const name = options.name || null;
  if (!name) error('env show requires --env <name> or env show <name>.');
  const environment = config.environments[name];
  if (!environment) {
    error(`Unknown environment '${name}'. Available: ${Object.keys(config.environments).join(', ') || '(none)'}`);
  }
  return {
    action: 'environment_show',
    workspace: config.root,
    name,
    environment,
    capabilities: sortedEntries(config.capability_definitions)
      .filter(([_capabilityName, capability]) => !capability.environment_kind || capability.environment_kind === environment.kind)
      .map(([capabilityName, capability]) => ({
        name: capabilityName,
        kind: capability.kind || null,
        maturity: capability.maturity || null,
      })),
  };
}

function capabilityList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  return {
    action: 'capability_list',
    workspace: config.root,
    capabilities: sortedEntries(config.capability_definitions).map(([name, capability]) => ({
      name,
      kind: capability.kind || null,
      maturity: capability.maturity || null,
      environment_kind: capability.environment_kind || null,
      evidence_gate: normalizeStringList(capability.evidence_gate),
      production_gate: capability.production_gate === true,
    })),
  };
}

function capabilityShow(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const name = options.name || null;
  if (!name) error('capability show requires --method <name> or capability show <name>.');
  const capability = config.capability_definitions[name];
  if (!capability) {
    error(`Unknown capability '${name}'. Available: ${Object.keys(config.capability_definitions).join(', ') || '(none)'}`);
  }
  return {
    action: 'capability_show',
    workspace: config.root,
    name,
    capability,
    environments: sortedEntries(config.environments)
      .filter(([_envName, env]) => !capability.environment_kind || env.kind === capability.environment_kind)
      .map(([envName, env]) => ({
        name: envName,
        kind: env.kind || null,
        status: env.status || null,
      })),
    validation_instances: sortedEntries(config.validation_instances)
      .filter(([_instanceName, instance]) => instance.capability === name)
      .map(([instanceName, instance]) => compactInstance(instanceName, instance)),
    deploy_instances: sortedEntries(config.deploy_instances)
      .filter(([_instanceName, instance]) => instance.capability === name)
      .map(([instanceName, instance]) => compactInstance(instanceName, instance)),
  };
}

function instanceMatchesSelection(instance, selection) {
  if (!selection.track) return true;
  if (instance.track !== selection.track) return false;
  if (selection.feat && (instance.feat || null) && instance.feat !== selection.feat) return false;
  return true;
}

function preferScopedInstances(entries, selection) {
  if (!selection.feat) return entries;
  const exact = entries.filter(([_name, instance]) => (instance.feat || null) === selection.feat);
  return exact.length ? exact : entries.filter(([_name, instance]) => !(instance.feat || null));
}

function instanceMatchesFilters(instance, filters = {}) {
  if (filters.method && instance.capability !== filters.method) return false;
  if (filters.environment && instance.environment !== filters.environment) return false;
  return true;
}

function expectedFacts(capability) {
  return normalizeStringList(capability.requires && capability.requires.facts
    ? capability.requires.facts
    : capability.requires);
}

function factPresent(environment, instance, fact) {
  const key = String(fact || '');
  if (!key) return true;
  const aliases = {
    entry_ssh: ['entry_ssh', 'ssh'],
    ssh: ['ssh', 'entry_ssh'],
    namespace: ['namespace'],
    node: ['node'],
    dev_image: ['dev_image', 'image'],
    model_root: ['model_root'],
    cache_root: ['cache_root'],
    source_root: ['source_root'],
    venv_root: ['venv_root'],
    source_dir: ['source_dir'],
    venv: ['venv', 'venv_path'],
    python_3_12: ['python_version', 'python'],
    network_access: ['proxy', 'registry', 'network_access'],
  };
  const keys = aliases[key] || [key];
  for (const candidate of keys) {
    if (instance && instance[candidate] != null && instance[candidate] !== '') return true;
    if (environment && environment[candidate] != null && environment[candidate] !== '') return true;
  }
  if (key === 'node' && environment && Array.isArray(environment.nodes) && environment.nodes.length) return true;
  if (key === 'namespace' && environment && Array.isArray(environment.namespace_defaults) && environment.namespace_defaults.length) return true;
  return false;
}

function runtimeSource(runtime) {
  return runtime && runtime.shell && runtime.shell.source
    ? runtime.shell.source
    : null;
}

function withRuntimeSource(command, runtime) {
  const source = runtimeSource(runtime);
  if (!command || !source) return command;
  return `${source} && ${command}`;
}

function instanceCommands(config, name, instance, capability, runtime = null) {
  const commands = {};
  const trackArgs = [
    '--root', JSON.stringify(config.root),
    instance.track ? '--set' : null,
    instance.track ? JSON.stringify(instance.track) : null,
    instance.feat ? '--feat' : null,
    instance.feat ? JSON.stringify(instance.feat) : null,
  ].filter(Boolean);
  if (instance.current_profile || instance.env_profile) {
    const profile = instance.current_profile || instance.env_profile;
    commands.doctor = withRuntimeSource(
      `node ${JSON.stringify(require('path').join(__dirname, 'devteam.cjs'))} env doctor ${trackArgs.join(' ')} --profile ${JSON.stringify(profile)} --remote`,
      runtime
    );
  }
  if (capability && capability.source_mode && String(capability.source_mode).includes('rsync')) {
    commands.sync_plan = withRuntimeSource(
      `node ${JSON.stringify(require('path').join(__dirname, 'devteam.cjs'))} sync plan ${trackArgs.join(' ')}`,
      runtime
    );
  }
  if (capability && String(capability.source_mode || '') === 'git-in-pod') {
    commands.k8s_helper = instance.helper || (capability.artifacts && capability.artifacts.helper) || null;
    const helper = commands.k8s_helper || '.devteam/scripts/vllm_k8s_dev.py';
    if (commands.doctor) {
      commands.env_doctor = commands.doctor;
    }
    commands.doctor = withRuntimeSource(`${helper} doctor --instance ${name}`, runtime);
    commands.bootstrap = withRuntimeSource(`${helper} bootstrap --instance ${name}`, runtime);
    commands.snapshot = withRuntimeSource(`${helper} snapshot --instance ${name}`, runtime);
  }
  if (runtimeSource(runtime)) {
    commands.runtime_env = runtimeSource(runtime);
  }
  return commands;
}

function validateList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: false,
  });
  const instances = preferScopedInstances(sortedEntries(config.validation_instances)
    .filter(([_name, instance]) => instanceMatchesSelection(instance, selection))
    .filter(([_name, instance]) => instanceMatchesFilters(instance, options)), selection)
    .map(([name, instance]) => compactInstance(name, instance));
  return {
    action: 'validate_list',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    method: options.method || null,
    environment: options.environment || null,
    instances,
  };
}

function validatePlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: true,
    label: 'validate plan track',
  });
  const candidates = preferScopedInstances(sortedEntries(config.validation_instances)
    .filter(([_name, instance]) => instanceMatchesSelection(instance, selection))
    .filter(([_name, instance]) => instanceMatchesFilters(instance, options)), selection);
  const chosen = options.instance
    ? candidates.find(([name]) => name === options.instance) || null
    : candidates[0] || null;
  if (!chosen) {
    return {
      action: 'validate_plan',
      workspace: config.root,
      track: selection.track,
      feat: selection.feat || null,
      method: options.method || null,
      environment: options.environment || null,
      status: 'missing_instance',
      instances: candidates.map(([name, instance]) => compactInstance(name, instance)),
      next_action: 'Add a validation_instances entry for this track/feature, method, and environment.',
    };
  }
  const [instanceName, instance] = chosen;
  const capability = config.capability_definitions[instance.capability] || {};
  const environment = config.environments[instance.environment] || {};
  const facts = expectedFacts(capability);
  const missing = facts.filter(fact => !factPresent(environment, instance, fact));
  const { buildRuntimeContext } = require('./runtime-context.cjs');
  const runtime = buildRuntimeContext({
    config,
    set: selection.track,
    feat: selection.feat || null,
    profile: instance.current_profile || instance.env_profile || null,
    environment: instance.environment || null,
    required: true,
  });
  return {
    action: 'validate_plan',
    workspace: config.root,
    track: selection.track,
    feat: selection.feat || null,
    instance: instanceName,
    capability: instance.capability || null,
    environment: instance.environment || null,
    status: missing.length ? 'incomplete' : 'ready',
    production_gate: capability.production_gate === true,
    maturity: capability.maturity || instance.maturity || null,
    capability_definition: capability,
    environment_ref: {
      name: instance.environment || null,
      kind: environment.kind || null,
      status: environment.status || null,
    },
    validation_instance: instance,
    runtime,
    required_facts: facts,
    missing,
    evidence_gate: normalizeStringList(capability.evidence_gate),
    commands: instanceCommands(config, instanceName, instance, capability, runtime),
    next_action: missing.length
      ? `Fill missing environment/instance facts: ${missing.join(', ')}`
      : 'Review the plan, then run the explicit doctor/bootstrap/sync/test command for this validation instance.',
  };
}

function renderValidatePlanText(plan) {
  const runtime = plan.runtime || {};
  const lines = [
    'Validation Plan',
    '',
    `Workspace: ${plan.workspace}`,
    `Track: ${plan.track || '-'}`,
    plan.feat ? `Feature: ${plan.feat}` : null,
    `Instance: ${plan.instance || '-'}`,
    `Capability: ${plan.capability || plan.method || '-'}`,
    `Environment: ${plan.environment || '-'}`,
    `Status: ${plan.status}`,
    `Production gate: ${plan.production_gate === true ? 'yes' : 'no'}`,
    `Required facts: ${plan.required_facts && plan.required_facts.length ? plan.required_facts.join(', ') : '-'}`,
    `Missing: ${plan.missing && plan.missing.length ? plan.missing.join(', ') : '-'}`,
    `Evidence gate: ${plan.evidence_gate && plan.evidence_gate.length ? plan.evidence_gate.join(', ') : '-'}`,
    runtime.shell && runtime.shell.source ? `Runtime env: ${runtime.shell.source}` : null,
    '',
    'Commands:',
  ].filter(Boolean);
  const commands = plan.commands || {};
  if (Object.keys(commands).length) {
    for (const [name, command] of Object.entries(commands)) {
      lines.push(`  ${name}: ${command}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('', `Next: ${plan.next_action || '-'}`);
  return lines.join('\n');
}

function handleCapability(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'list') {
    output(capabilityList({ root: parsed.root || null }));
    return;
  }
  if (subcommand === 'show') {
    output(capabilityShow({
      root: parsed.root || null,
      name: parsed.method || parsed._[0] || null,
    }));
    return;
  }
  error(`Unknown capability subcommand: '${subcommand}'. Use: list, show`);
}

function handleValidate(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'list') {
    output(validateList({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      method: parsed.method || null,
      environment: parsed.env || parsed.environment || null,
    }));
    return;
  }
  if (subcommand === 'plan') {
    const plan = validatePlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      method: parsed.method || null,
      environment: parsed.env || parsed.environment || null,
      instance: parsed.instance || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderValidatePlanText(plan) + '\n');
    } else {
      output(plan);
    }
    return;
  }
  error(`Unknown validate subcommand: '${subcommand}'. Use: list, plan`);
}

module.exports = {
  capabilityList,
  capabilityShow,
  environmentList,
  environmentShow,
  handleCapability,
  handleValidate,
  validateList,
  validatePlan,
  renderValidatePlanText,
};
