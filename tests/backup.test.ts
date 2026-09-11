import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db.js';
import { createBackup, restoreBackup } from '../src/server/backup.js';
import { fixture } from './helpers.js';
test('consistent backup does not interrupt live records; restore invalidates stale credentials and gates employee reactivation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coding-access-backup-')); const f = await fixture(); const source = new Store(join(dir, 'source.sqlite'));
  try {
    for (const u of f.store.users()) source.saveUser(u); for (const p of f.store.providers()) source.saveProvider(p); for (const m of f.store.models()) source.saveModel(m); for (const k of f.store.keys()) source.saveKey(k);
    source.issue(f.employee.id, 'api', 'employee-device'); const running = source.beginRequest(f.employee.id, 'glm-test', 'claude-code');
    writeFileSync(join(dir, '.env'), `ACA_MASTER_KEY=${Buffer.alloc(32, 7).toString('base64')}\nACA_ADMIN_USERNAME=admin\n`);
    createBackup(join(dir, 'source.sqlite'), join(dir, '.env'), join(dir, 'snapshot'));
    expect(source.requests()[0].status).toBe('running');
    await restoreBackup(join(dir, 'snapshot'), join(dir, 'restored.sqlite'), join(dir, 'restored.env'));
    const restored = new Store(join(dir, 'restored.sqlite'));
    try { expect(restored.user(f.employee.id)?.enabled).toBe(false); expect(restored.user(f.admin.id)).toMatchObject({ enabled: true, mustChangePassword: true }); expect((restored.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE revoked=0').get() as any).n).toBe(0); expect(restored.key('z1')).toBeTruthy(); } finally { restored.close(); }
  } finally { source.close(); f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
