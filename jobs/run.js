/* 의왕의힘33 알림 도우미 — GitHub가 5분마다 실행합니다.
   1) 공지: 등록 직후 · 하루 전 오전 9시 · 당일 오전 9시 · 1시간 전 → 승인 회원 전체
   2) 유세: 등록 직후 동행 모집 → 회원 전체 / 전날 오후 8시 · 집결 1시간 전 → 동행 신청자
   3) 가입 신청 → 최고 관리자와 검토자에게만
   4) 위원장 페이스북 새 글 → 회원 전체 (페이스북 ‘페이지’ 연결 시 30분마다 새 글 자동 가져오기)
   5) 관리자가 요청한 회원 비밀번호 초기화 */
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('FIREBASE_SERVICE_ACCOUNT 비밀 값이 없습니다. 안내서 9단계를 확인하세요.'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const WD = ['일','월','화','수','목','금','토'];
const kst = (date, time) => Date.parse(`${date}T${time}:00+09:00`);
const NOW = Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function roles(){ const s = await db.doc('roles/main').get(); const d = s.exists ? s.data() : {}; return { owner: d.owner || '', admins: d.admins || [], reviewers: d.reviewers || [] }; }
let _all = null;
async function everyone(){
  if (_all) return _all;
  const r = await roles();
  const snap = await db.collection('members').where('status', '==', 'approved').get();
  _all = [...new Set([...snap.docs.map(d => d.id), r.owner, ...r.admins, ...r.reviewers].filter(Boolean))];
  return _all;
}

/* 받는 사람들의 기기로 보냅니다. 끊긴 기기는 정리합니다. */
async function pushTo(uids, title, body, view, tag){
  uids = [...new Set(uids.filter(Boolean))];
  if (!uids.length) return 0;
  const owners = [], tokens = [];
  for (let i = 0; i < uids.length; i += 30){
    const snap = await db.collection('tokens').where(admin.firestore.FieldPath.documentId(), 'in', uids.slice(i, i + 30)).get();
    snap.forEach(d => (d.data().tokens || []).forEach(t => { tokens.push(t); owners.push(d.id); }));
  }
  if (!tokens.length) return 0;
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500){
    const batch = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: { view: view || 'notices', tag: tag || '' },
      webpush: { fcmOptions: { link: '/#' + (view || 'notices') }, notification: { icon: '/icons/icon-192.png', tag: tag || undefined } },
    });
    sent += res.successCount;
    for (let k = 0; k < res.responses.length; k++){
      const c = res.responses[k].error && res.responses[k].error.code;
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token')
        await db.doc('tokens/' + owners[i + k]).update({ tokens: admin.firestore.FieldValue.arrayRemove(batch[k]) }).catch(() => {});
    }
  }
  return sent;
}
function whenText(n, atMs){
  const at = new Date(atMs + 9 * 3600000);
  const h = at.getUTCHours(), m = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCMonth() + 1}.${at.getUTCDate()}(${WD[at.getUTCDay()]}) ${h < 12 ? '오전' : '오후'} ${(h % 12) || 12}:${m}` + (n.place ? ` · ${n.place}` : '');
}

/* 1) 공지 */
async function notices(){
  const snap = await db.collection('notices').where('atMs', '>', NOW).get();
  for (const d of snap.docs){
    const n = d.data(); const sent = n.sent || {};
    const atMs = n.atMs || kst(n.date, n.time);
    const created = Date.parse(n.createdAt || '') || NOW;
    const stages = [
      { k: 'new', t: created, title: '[새 공지] ' + n.title },
      { k: 'd1', t: kst(n.date, '09:00') - 86400000, title: '[내일] ' + n.title },
      { k: 'd0', t: kst(n.date, '09:00'), title: '[오늘] ' + n.title },
      { k: 'h1', t: atMs - 3600000, title: '[1시간 뒤] ' + n.title },
    ].filter(s => s.t < atMs);
    const upd = {};
    stages.filter(s => s.k !== 'new' && s.t < created && !sent[s.k]).forEach(s => { upd['sent.' + s.k] = true; });   // 등록 전에 이미 지난 단계는 건너뜀
    const due = stages.filter(s => s.t <= NOW && !sent[s.k] && !upd['sent.' + s.k]).sort((a, b) => a.t - b.t);
    if (due.length){
      const s = due[due.length - 1];
      const c = await pushTo(await everyone(), s.title, whenText(n, atMs), 'notices', 'notice-' + d.id);
      due.forEach(x => { upd['sent.' + x.k] = true; });
      log('공지', n.title, s.k, c + '대');
    }
    if (Object.keys(upd).length) await d.ref.update(upd);
  }
}

/* 2) 유세 */
async function rallies(){
  const snap = await db.collection('rallies').where('atMs', '>', NOW - 6 * 3600000).get();
  for (const d of snap.docs){
    const r = d.data(); const sent = r.sent || {}; const upd = {};
    const meet = r.meetMs || r.atMs;
    if (!sent.created){
      if (r.atMs > NOW){
        const [y, m, dd] = r.date.split('-').map(Number); const w = WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
        const c = await pushTo(await everyone(), '[유세 동행 모집] ' + r.place, `${m}.${dd}(${w}) ${r.start} ${r.type || ''} · 필요 ${r.need || 0}명 — 동행 신청해 주세요`, 'rally', 'rally-' + d.id);
        log('유세 모집', r.place, c + '대');
      }
      upd['sent.created'] = true;
    }
    const crew = r.crew || [];
    const st = [
      { k: 'eve', t: kst(r.date, '20:00') - 86400000, title: '[내일 유세 동행] ' + r.place, body: `${r.meetAt || r.start} 집결 · ${r.meetPlace || r.place}` + (r.items ? ` · 준비물: ${r.items}` : '') },
      { k: 'h1', t: meet - 3600000, title: '[1시간 뒤 집결] ' + r.place, body: `${r.meetAt || r.start} · ${r.meetPlace || r.place}` },
    ].filter(x => x.t < meet);
    const due = st.filter(x => x.t <= NOW && !sent[x.k] && NOW < meet);
    if (due.length){
      const x = due[due.length - 1];
      if (crew.length){ const c = await pushTo(crew, x.title, x.body, 'rally', 'rally-' + d.id); log('유세 동행', r.place, x.k, c + '대'); }
      due.forEach(y => { upd['sent.' + y.k] = true; });
    }
    if (Object.keys(upd).length) await d.ref.update(upd);
  }
}

/* 3) 가입 신청 */
async function applicants(){
  const snap = await db.collection('members').where('notified', '==', false).get();
  if (snap.empty) return;
  const r = await roles();
  for (const d of snap.docs){
    const m = d.data();
    if (m.status === 'pending'){
      const c = await pushTo([r.owner, ...r.reviewers], '새 회원 가입 신청', `${m.name || ''}님 (${m.dong || ''}) — 승인 또는 불가를 선택해 주세요`, 'admin', 'apply-' + d.id);
      log('가입 신청', m.name, c + '대');
    }
    await d.ref.update({ notified: true });
  }
}

/* 4) 페이스북 */
async function facebook(){
  const cfg = await db.doc('fbconfig/main').get();
  if (cfg.exists){
    const { pageId, token, lastRun } = cfg.data();
    if (pageId && token && (!lastRun || NOW - Date.parse(lastRun) > 25 * 60000)){
      try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/posts?fields=id,message,permalink_url,created_time&limit=5&access_token=${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok || json.error) throw new Error((json.error && json.error.message) || String(res.status));
        for (const p of (json.data || []).reverse()){
          if (!p.permalink_url) continue;
          const ref = db.doc('fbposts/fb_' + String(p.id).replace(/[^0-9_]/g, ''));
          if ((await ref.get()).exists) continue;
          await ref.set({ url: p.permalink_url, text: (p.message || '').replace(/\s+/g, ' ').trim().slice(0, 120), source: 'auto', postedAt: p.created_time, notified: false, createdAt: new Date().toISOString() });
          log('페이스북 새 글 가져옴', p.id);
        }
        await cfg.ref.update({ lastError: '', lastRun: new Date().toISOString() });
      } catch (e){ await cfg.ref.update({ lastError: String(e.message || e), lastRun: new Date().toISOString() }); log('페이스북 가져오기 실패', e.message); }
    }
  }
  const snap = await db.collection('fbposts').where('notified', '==', false).get();
  for (const d of snap.docs){
    const p = d.data();
    const c = await pushTo(await everyone(), '위원장님 페이스북 새 글', (p.text ? p.text + ' — ' : '') + '공유해서 더 많은 시민께 알려 주세요', 'news', 'fb-' + d.id);
    await d.ref.update({ notified: true });
    log('페이스북 알림', c + '대');
  }
}

/* 5) 비밀번호 초기화 */
async function resets(){
  const snap = await db.collection('resetRequests').where('done', '==', false).get();
  if (snap.empty) return;
  const r = await roles();
  const admins = new Set([r.owner, ...r.admins, ...r.reviewers]);
  for (const d of snap.docs){
    const q = d.data();
    if (!admins.has(q.by) || !q.uid){ await d.ref.update({ done: true, error: '관리자 요청이 아닙니다' }); continue; }
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let temp = ''; for (let i = 0; i < 8; i++) temp += chars[crypto.randomInt(chars.length)];
    try { await admin.auth().updateUser(q.uid, { password: temp }); await d.ref.update({ done: true, temp, doneAt: new Date().toISOString() }); log('비밀번호 초기화', q.name); }
    catch (e){ await d.ref.update({ done: true, error: '회원 계정을 찾지 못했습니다' }); }
  }
}

(async () => {
  for (const [name, fn] of [['공지', notices], ['유세', rallies], ['가입', applicants], ['페이스북', facebook], ['비밀번호', resets]]){
    try { await fn(); } catch (e){ console.error(name + ' 처리 중 오류:', e.message); process.exitCode = 1; }
  }
})();
