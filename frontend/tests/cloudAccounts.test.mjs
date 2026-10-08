import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {accountStatus,accountCheckResult,authReason,loginRequest,rebindQuestion,sessionExpired,sessionActive,usableAccount,safeQrImage,scanInstructions,qrSettingsPayload} from '../lib/cloudAccounts.ts';
test('verification requires a ready account, not just a successful HTTP response or stored credential',()=>{
  assert.deepEqual(accountCheckResult({configured:true,status:'ready'}),{state:'success',message:'账号验证通过'});
  for(const status of ['unverified','degraded','reauthorization_required','disconnected']) {
    assert.equal(accountCheckResult({configured:true,status}).state,'error');
  }
  assert.equal(accountCheckResult({configured:false,status:'ready'}).state,'error');
  assert.equal(accountCheckResult().state,'error');
  assert.match(accountCheckResult({configured:true,status:'reauthorization_required',lastErrorCode:'reauthorization_required'}).message,/重新连接/);
});
test('credential presence is not proof of a usable verified binding',()=>{
  for(const status of ['unverified','reauthorization_required','disconnected'])assert.equal(usableAccount({configured:true,status}),false);
  assert.equal(usableAccount({configured:true,status:'ready'}),true);
  assert.equal(usableAccount({configured:false,status:'ready'}),false);
  assert.equal(accountStatus('unknown'),'状态待确认');
});
test('expired and terminal sessions cannot keep polling or expose a remote image',()=>{
  const session={status:'waiting',expiresAt:'2026-01-01T00:00:00Z'};
  assert.equal(sessionExpired(session,Date.parse('2026-01-02')),true);
  assert.equal(sessionExpired({...session,status:'connected'},Date.parse('2026-01-02')),false);
  for(const s of ['connected','expired','cancelled','failed','denied'])assert.equal(sessionActive(s),false);
  assert.equal(safeQrImage('https://evil.test/a.png'),false);
  assert.equal(safeQrImage('data:text/html;base64,PHNjcmlwdD4='),false);
  assert.equal(safeQrImage('data:image/png;base64,aGVsbG8='),true);
  assert.match(authReason('account_mismatch'),/更换账号/);
  assert.match(authReason('credential_save:account_unverified'),/从未完成身份核实/);
  assert.match(authReason('credential_save:account_unverified'),/更换账号/);
  assert.match(authReason('credential_save:account_unverified'),/断开连接/);
  assert.notEqual(authReason('account_unverified'),authReason('account_mismatch'));
  // A session/row conflict is not an account switch: it must not send the admin
  // looking for the "更换账号" control.
  assert.match(authReason('credential_save:state_changed'),/账号状态或登录会话已变化/);
  assert.doesNotMatch(authReason('credential_save:state_changed'),/更换账号/);
  assert.doesNotMatch(authReason('token_exchange:state_changed'),/更换账号/);
});
test('login errors identify a safe stage without blaming every failure on account verification',()=>{
  assert.match(authReason('account_identity:provider_protocol_error'),/核实官方账号.*认证协议异常/);
  assert.match(authReason('root_access:permission_denied'),/根目录访问.*访问权限/);
  assert.match(authReason('token_exchange:network_error'),/兑换扫码授权.*连接失败/);
  assert.doesNotMatch(authReason('account_identity:provider_protocol_error'),/额外验证/);
  assert.match(authReason('token_exchange:authorization_exchange_uncertain'),/兑换扫码授权.*重新生成二维码/);
});
test('a credential that was never identity-verified must ask to rebind instead of re-authorizing',()=>{
  // A fresh connect, and a verified account being re-authorized, keep their intents.
  assert.deepEqual(loginRequest({configured:false}),{rebind:false,intent:'connect'});
  assert.deepEqual(loginRequest({configured:true,subjectId:'u1'}),{rebind:false,intent:'reauthorize'});
  // Never verified: the server refuses `reauthorize` because sameness is unknown,
  // so the plain button has to state the rebind explicitly.
  assert.deepEqual(loginRequest({configured:true}),{rebind:true,intent:'replace'});
  assert.deepEqual(loginRequest({configured:true,subjectId:null}),{rebind:true,intent:'replace'});
  // An explicit "更换账号" is always a rebind, verified or not.
  for(const account of [{configured:true,subjectId:'u1'},{configured:true},{configured:false}])
    assert.deepEqual(loginRequest(account,true),{rebind:true,intent:'replace'});
  // The unverified rebind must warn about rebinding, not about switching spaces.
  assert.match(rebindQuestion(false),/身份核实/);
  assert.match(rebindQuestion(false),/不会.*清理/);
  assert.doesNotMatch(rebindQuestion(false),/阿里存储空间/);
  assert.match(rebindQuestion(true),/阿里存储空间/);
});

test('Xunlei scan instructions distinguish experimental integration and safe recovery',()=>{
  assert.match(scanInstructions('xunlei'),/迅雷官方客户端/);
  assert.match(scanInstructions('xunlei'),/实验接入/);
  assert.match(authReason('token_exchange:client_configuration_required'),/客户端与设备配置/);
  assert.match(authReason('token_exchange:verification_required'),/官方网站/);
  assert.match(authReason('token_exchange:authorization_exchange_uncertain'),/重新生成二维码/);
  assert.match(scanInstructions('quark'),/夸克 App 的网盘扫一扫/);
});

test('QR settings preserve secrets on blank input and require explicit clear or replacement',()=>{
  const saved={enabled:false,configured:true,revision:4,experimental:true};
  assert.deepEqual(qrSettingsPayload(saved,true,''),{enabled:true,expectedRevision:4});
  assert.deepEqual(qrSettingsPayload(saved,false,'',true),{enabled:false,expectedRevision:4,clearContext:true});
  assert.deepEqual(qrSettingsPayload(saved,true,'{"client_id":"fixture"}'),{enabled:true,expectedRevision:4,context:{client_id:'fixture'}});
  assert.throws(()=>qrSettingsPayload({...saved,configured:false},true,''),/填写/);
  assert.throws(()=>qrSettingsPayload(saved,true,'',true),/关闭/);
  assert.throws(()=>qrSettingsPayload(saved,false,'not-json'),/有效的 JSON/);
  assert.throws(()=>qrSettingsPayload(saved,false,'[]'),/JSON 对象/);
  assert.throws(()=>qrSettingsPayload(saved,false,'"TOP_SECRET"'),/JSON 对象/);
  assert.throws(()=>qrSettingsPayload(saved,false,' '.repeat(65536)+'{}'),/64 KiB/);
});

test('Xunlei business QR settings do not use process environment configuration',()=>{
  for(const file of ['../../.env.example','../../src/main.rs','../../src/app.rs','../../src/cloud_auth/providers/xunlei.rs']) {
    assert.doesNotMatch(readFileSync(new URL(file,import.meta.url),'utf8'),/PANSOU_XUNLEI_QR_(?:ENABLED|CONTEXT_FILE)/);
  }
});
