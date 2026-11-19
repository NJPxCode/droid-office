import { execFile } from 'node:child_process';
import { lstatSync, statSync, type BigIntStats } from 'node:fs';

export function daemonArgs(port: number): string[] {
  return ['daemon', '--port', String(port), '--host', '127.0.0.1'];
}

function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 2_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function namesFile(fields: string[], file: BigIntStats): boolean {
  return fields.includes(`D0x${file.dev.toString(16)}`) && fields.includes(`i${file.ino}`);
}

/**
 * Legacy metadata has no office scope. Match the executable, exact launch command, listening
 * socket and inherited stdout/stderr against OS state. The log's text is not evidence, and
 * neither a copy nor a symlink/hard link to another office's log may confer ownership.
 */
export async function provesLegacyDaemonOwnership(platform: NodeJS.Platform, { pid, port, droidPath }: { pid: number; port: number; droidPath: string }, logFile: string): Promise<boolean> {
  const lsof = platform === 'darwin' ? '/usr/sbin/lsof' : platform === 'linux' ? '/usr/bin/lsof' : undefined;
  if (!lsof) return false;
  try {
    const log = lstatSync(logFile, { bigint: true });
    if (!log.isFile() || log.nlink !== 1n) return false;
    const executable = statSync(droidPath, { bigint: true });
    const [ps, output] = await Promise.all([command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']), command(lsof, ['-nP', '-a', '-p', String(pid), '-Ts', '-F0pfaDinT'])]);
    if (ps.trimEnd() !== [droidPath, ...daemonArgs(port)].join(' ')) return false;
    // With -F0, fields are NUL-delimited and each process/descriptor record ends in NUL + newline.
    const [processFields, ...descriptors] = output.split('\0\n').map((record) => record.split('\0'));
    if (processFields[0] !== `p${pid}` || descriptors.some((fields) => fields[0].startsWith('p'))) return false;
    const current = lstatSync(logFile, { bigint: true });
    if (!current.isFile() || current.nlink !== 1n || current.dev !== log.dev || current.ino !== log.ino) return false;
    const redirectsToLog = (fd: string) => descriptors.some((fields) => fields[0] === fd && fields.includes('aw') && fields.includes(`n${logFile}`) && namesFile(fields, log));
    return (
      redirectsToLog('f1') &&
      redirectsToLog('f2') &&
      descriptors.some((fields) => fields[0] === 'ftxt' && namesFile(fields, executable)) &&
      descriptors.some((fields) => /^f\d+$/.test(fields[0]) && fields.includes(`n127.0.0.1:${port}`) && fields.includes('TST=LISTEN'))
    );
  } catch {
    // Absent/rotated log, process exit, unsupported tooling, or missing permissions: fail closed.
    return false;
  }
}
