import { resolve } from 'node:path';
import { inspectSourceCoordinationLease, recoverSourceCoordinationLease } from '../server/storage/sourceCoordination.mjs';

const args = process.argv.slice(2);
const requestedAction = args[0] || 'unknown';

try {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const dataDir = resolve(options.dataDir || 'data');
    if (options.action === 'inspect') {
      const inspection = await inspectSourceCoordinationLease(dataDir);
      writeJson(process.stdout, {
        ok: true,
        action: 'inspect',
        ...inspection
      });
    } else {
      const recovery = await recoverSourceCoordinationLease(dataDir, {
        force: options.force,
        expectedToken: options.token
      });
      writeJson(process.stdout, { ok: true, ...recovery });
    }
  }
} catch (error) {
  writeJson(process.stderr, {
    ok: false,
    action: ['inspect', 'recover'].includes(requestedAction) ? requestedAction : 'unknown',
    auditedAt: new Date().toISOString(),
    code: error?.code ?? 'SOURCE_COORDINATION_CLI_INVALID',
    message: error?.message ?? String(error),
    audit: error?.audit ?? null
  });
  process.exitCode = 1;
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    return { help: true };
  }
  const action = argv[0];
  if (!['inspect', 'recover'].includes(action)) {
    throw cliError(`first argument must be inspect or recover\n${usage()}`);
  }

  const output = {
    action,
    dataDir: '',
    token: '',
    force: false,
    help: false
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') {
      rejectDuplicate(seen, arg);
      output.dataDir = requireValue(argv, ++index, arg);
    } else if (arg === '--token') {
      rejectDuplicate(seen, arg);
      output.token = requireValue(argv, ++index, arg);
    } else if (arg === '--force') {
      rejectDuplicate(seen, arg);
      output.force = true;
    } else if (['--help', '-h'].includes(arg)) {
      output.help = true;
    } else {
      throw cliError(`unknown argument: ${arg}`);
    }
  }

  if (output.help) return output;
  if (action === 'inspect' && (output.force || output.token)) {
    throw cliError('inspect does not accept --force or --token');
  }
  return output;
}

function rejectDuplicate(seen, flag) {
  if (seen.has(flag)) throw cliError(`duplicate argument: ${flag}`);
  seen.add(flag);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw cliError(`${flag} requires a value`);
  return value;
}

function cliError(message, code = 'SOURCE_COORDINATION_CLI_INVALID') {
  const error = /** @type {Error & Record<string, any>} */ (new Error(message));
  error.code = code;
  return error;
}

function usage() {
  return [
    'Usage:',
    '  npm run source:lease -- inspect [--data-dir <path>]',
    '  npm run source:lease -- recover [--data-dir <path>] --token <inspect-token> --force',
    '',
    'Foreign-host PID liveness cannot be checked locally. Recover only after confirming the original writer is stopped.'
  ].join('\n');
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
