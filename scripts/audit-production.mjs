import { spawnSync } from 'node:child_process';

const result = spawnSync('corepack', ['pnpm', 'audit', '--prod', '--audit-level=high', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout || 'pnpm audit returned no parseable report\n');
  process.exit(1);
}

if (
  result.error
  || result.signal
  || (result.status !== 0 && result.status !== 1)
  || report.error
  || !report.advisories
  || !report.metadata
  || !report.metadata.vulnerabilities
  || !Number.isInteger(report.metadata.totalDependencies)
) {
  const reason = result.error?.message
    ?? (result.signal ? `terminated by ${result.signal}` : undefined)
    ?? report.error?.summary
    ?? report.error?.message
    ?? `unexpected pnpm audit result (status ${String(result.status)})`;
  process.stderr.write(`Production audit could not be completed: ${reason}\n`);
  process.exit(1);
}

const waivers = new Map([
  ['GHSA-ggr8-5vv4-36mx', {
    expires: new Date('2026-09-30T00:00:00.000Z'),
    rationale: 'deepmerge-ts is reachable only through Prisma CLI/config build tooling; the production image excludes prisma, @prisma/config, and deepmerge-ts. The advisory names v8 as patched, but npm has not published v8 yet.',
    accepts: (advisory) => advisory.module_name === 'deepmerge-ts'
      && Array.isArray(advisory.findings)
      && advisory.findings.length > 0
      && advisory.findings.every((finding) => Array.isArray(finding.paths)
        && finding.paths.length > 0
        && finding.paths.every((path) => path.includes('@prisma/config'))),
  }],
]);

const severe = Object.values(report.advisories ?? {})
  .filter((advisory) => advisory.severity === 'high' || advisory.severity === 'critical');
const failures = [];

for (const advisory of severe) {
  const waiver = waivers.get(advisory.github_advisory_id);
  if (!waiver || !waiver.accepts(advisory)) {
    failures.push(`${advisory.github_advisory_id ?? advisory.id}: ${advisory.title}`);
    continue;
  }
  if (Date.now() >= waiver.expires.getTime()) {
    failures.push(`${advisory.github_advisory_id}: temporary waiver expired ${waiver.expires.toISOString()}`);
    continue;
  }
  process.stdout.write(`WAIVED until ${waiver.expires.toISOString()}: ${advisory.github_advisory_id}\n${waiver.rationale}\n`);
}

if (failures.length) {
  process.stderr.write(`Unwaived high/critical production advisories:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(`Production audit passed (${severe.length} explicitly reviewed high/critical advisory record(s)).\n`);
