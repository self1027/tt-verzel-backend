import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createApp } from '../../src/app.ts';
import { serve } from '../helpers/http.js';
import { Router } from 'express';
import { loginRateLimit } from '../../src/modules/auth/infrastructure/login-rate-limit.ts';

test('the original twelve invalid login attempts are bounded and the temporary budget expires', async () => {
  const f = await isolatedDatabase(); let http;
  try {
    await seed(f.db, seedConfig);
    const auth = await createAuthModule(f.db, { jwtSecret: 'rate-limit-test-secret-at-least-32-bytes', jwtExpiresInSeconds: 900 });
    http = await serve(createApp(auth.router));
    const attempts = [];
    for (let i = 0; i < 12; i++) {
      const response = await fetch(http.url + '/auth/login', { method:'POST',headers:{'content-type':'application/json','x-forwarded-for':`198.51.100.${i+1}`},body:JSON.stringify({email:i%2?' UNKNOWN@AUDIT.INVALID ':'unknown@audit.invalid',password:'wrong-password'}) });
      attempts.push(response.status);
      if (response.status === 429) {
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal((await response.json()).error.code, 'TOO_MANY_LOGIN_ATTEMPTS');
      }
    }
    assert.deepEqual(attempts, [...Array(10).fill(401),429,429]);
    await f.pool.query("UPDATE login_rate_limits SET expires_at=clock_timestamp()-interval '1 second'");
    const response=await fetch(http.url+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'unknown@audit.invalid',password:'wrong-password'})});
    assert.equal(response.status,401);
  } finally { await http?.close();await f.close(); }
});

test('budgets are shared between API instances, proxy headers are opt-in, and denied requests do not extend expiry', async () => {
  const f=await isolatedDatabase();const servers=[];
  try {
    let work=0;
    const start=async trusted=>{
      const router=Router();router.post('/login',loginRateLimit(f.db,{perIp:2,perAccount:10}),(_req,res)=>{work++;res.json({ok:true});});
      const http=await serve(createApp(router,undefined,undefined,undefined,undefined,{trustedProxies:trusted}));servers.push(http);return http;
    };
    const a=await start([]),b=await start([]);
    const post=(http,ip,email)=>fetch(http.url+'/auth/login',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':ip},body:JSON.stringify({email,password:'unused'})});
    assert.equal((await post(a,'198.51.100.1','a@test.invalid')).status,200);
    assert.equal((await post(b,'198.51.100.2','b@test.invalid')).status,200);
    const expiry=(await f.pool.query('SELECT key,expires_at::text FROM login_rate_limits ORDER BY key')).rows;
    const blocked=await post(b,'198.51.100.3','c@test.invalid');assert.equal(blocked.status,429);assert.equal(work,2);
    assert.deepEqual((await f.pool.query('SELECT key,expires_at::text FROM login_rate_limits ORDER BY key')).rows,expiry);
    await f.pool.query('DELETE FROM login_rate_limits');
    const trusted=await start(['127.0.0.1/32']);
    assert.equal((await post(trusted,'198.51.100.1','a@test.invalid')).status,200);
    assert.equal((await post(trusted,'198.51.100.1','a@test.invalid')).status,200);
    assert.equal((await post(trusted,'198.51.100.1','a@test.invalid')).status,429);
    assert.equal((await post(trusted,'198.51.100.2','b@test.invalid')).status,200);
    await f.pool.query('DELETE FROM login_rate_limits');
    const responses=await Promise.all(Array.from({length:6},()=>post(trusted,'2001:db8::1','concurrent@test.invalid')));
    assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(responses.filter(r=>r.status===429).length,4);
  }finally{for(const http of servers)await http.close();await f.close();}
});
