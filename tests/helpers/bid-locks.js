import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export async function holdRow(pool, query, values) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await client.query(query, values);
    let released = false;
    return { pid, async release() {
      if (released) return;
      released = true;
      try { await client.query('ROLLBACK'); } finally { client.release(); }
    } };
  } catch (error) { await client.query('ROLLBACK'); client.release(); throw error; }
}

export async function waitBlocked(pool, holderPid, minimum = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = (await pool.query(`WITH RECURSIVE waiting(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
    ) SELECT pid FROM waiting`, [holderPid])).rows;
    if (rows.length >= minimum) return rows.map((row) => row.pid);
    await setTimeout(10);
  }
  assert.fail(`Expected ${minimum} PostgreSQL sessions blocked by ${holderPid}`);
}

export async function waitDatabaseDeadline(pool, deadline) {
  const timeout = Date.now() + 5000;
  while (Date.now() < timeout) {
    if ((await pool.query('SELECT clock_timestamp() >= $1::timestamp AT TIME ZONE \'UTC\' AS expired', [deadline])).rows[0].expired) return;
    await setTimeout(10);
  }
  assert.fail('Database deadline was not reached');
}
