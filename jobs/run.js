/* 의왕의힘 알림 도우미 — GitHub가 5분마다 실행합니다.
   1) 공지·일정(board): 새 글 · 하루 전 오전 9시 · 당일 오전 9시 · 1시간 전 · 회의록 → 승인 회원 전체
   2) 유세: 등록 직후 동행 모집 → 회원 전체 / 전날 오후 8시 · 집결 1시간 전 → 동행 신청자
   3) 가입 신청 → 최고 관리자와 검토자에게만
   4) 위원장 페이스북 새 글 → 회원 전체 (페이스북 ‘페이지’ 연결 시 30분마다 새 글 자동 가져오기)
   5) 관리자가 요청한 회원 비밀번호 초기화
   6) 가입 승인 → 승인된 본인에게 ‘승인 완료’ 알림 (누르면 사이트가 열리고 홈 화면 설치 안내가 나옴) */
const admin = require('firebase-admin');
const crypto = require('crypto');
const { kstDay, needsRecount, leaderStats, whenText, bundlePush, dueStage, supSplit } = require('./lib');

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
/* 1) 공지·일정(board) — 같은 때 보낼 알림은 1개로 묶음 (제목은 오늘과 가장 가까운 일정, 나머지는 ‘외 N건’)
   ① 새 글(pendingNew) ② 미리 알림(하루 전 9시·당일 9시·1시간 전, dueStage) ③ 회의록(pendingMinutes)
   보낸 뒤에 표시함 (보내다 실패하면 다음 실행에 다시) */
const NOTICE_LABEL = { d1: '내일', d0: '오늘', h1: '1시간 뒤' };
async function boardJob(){
  const send = async (label, items, tag) => { const p = bundlePush(label, items); if (!p) return;
    const c = await pushTo(await everyone(), p.title, p.body, 'board', 'board-' + tag + '-' + NOW); log('공지·일정', label, items.length + '건', c + '대'); };
  const item = x => ({ title: x.title || '', sub: x.atMs ? whenText(x, x.atMs) : '날짜 없는 공지', at: x.atMs || Number.MAX_SAFE_INTEGER });

  const fresh = await db.collection('board').where('pendingNew', '==', true).get();
  await send('새 공지', fresh.docs.map(d => item(d.data())), 'new');
  for (const d of fresh.docs) await d.ref.update({ pendingNew: false });

  const soon = await db.collection('board').where('atMs', '>', NOW).get();
  const groups = { d1: [], d0: [], h1: [] }, updates = [];
  for (const d of soon.docs){ const x = d.data(), r = dueStage(x, NOW);
    if (r.send) groups[r.send].push(item(x));
    if (r.mark.length) updates.push([d.ref, Object.fromEntries(r.mark.map(k => ['sent.' + k, true]))]); }
  for (const k of Object.keys(groups)) await send(NOTICE_LABEL[k], groups[k], k);
  for (const [ref, upd] of updates) await ref.update(upd);

  const mins = await db.collection('board').where('pendingMinutes', '==', true).get();
  await send('회의록', mins.docs.map(d => item(d.data())), 'min');
  for (const d of mins.docs) await d.ref.update({ pendingMinutes: false });
}

/* 2) 유세 */
/* 동행 모집 알림은 여러 개를 한꺼번에 올려도 1개로 묶음 (가장 가까운 활동이 제목).
   동행 신청자에게 가는 ‘전날 저녁·1시간 뒤 집결’ 알림은 사람마다 중요한 알림이라 지금처럼 활동마다 따로 */
async function rallies(){
  const snap = await db.collection('rallies').where('atMs', '>', NOW - 6 * 3600000).get();
  const recruit = [], created = [];
  for (const d of snap.docs){
    const r = d.data(); const sent = r.sent || {}; const upd = {};
    if (r.law){ if (!sent.created) await d.ref.update({ 'sent.created': true }); continue; }   // 법정 일정은 동행 모집 알림을 보내지 않음
    const meet = r.meetMs || r.atMs;
    if (!sent.created){
      if (r.atMs > NOW){
        const [y, m, dd] = r.date.split('-').map(Number); const w = WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
        recruit.push({ title: r.place, sub: `${m}.${dd}(${w}) ${r.start} ${r.type || ''} · 필요 ${r.need || 0}명 — 동행 신청해 주세요`, at: r.atMs });
      }
      created.push(d.ref);   // 모집 알림을 보낸 뒤 표시
    }
    const crew = r.crew || [];
    const st = [
      { k: 'eve', t: kst(r.date, '20:00') - 86400000, title: '[내일 활동 동행] ' + r.place, body: `${r.meetAt || r.start} 집결 · ${r.meetPlace || r.place}` + (r.items ? ` · 준비물: ${r.items}` : '') },
      { k: 'h1', t: meet - 3600000, title: '[1시간 뒤 집결] ' + r.place, body: `${r.meetAt || r.start} · ${r.meetPlace || r.place}` },
    ].filter(x => x.t < meet);
    const due = st.filter(x => x.t <= NOW && !sent[x.k] && NOW < meet);
    if (due.length){
      const x = due[due.length - 1];
      if (crew.length){ const c = await pushTo(crew, x.title, x.body, 'rally', 'rally-' + d.id); log('활동 동행', r.place, x.k, c + '대'); }
      due.forEach(y => { upd['sent.' + y.k] = true; });
    }
    if (Object.keys(upd).length) await d.ref.update(upd);
  }
  const p = bundlePush('활동 동행 모집', recruit);
  if (p){ const c = await pushTo(await everyone(), p.title, p.body, 'rally', 'rally-new-' + NOW); log('활동 모집', recruit.length + '건', c + '대'); }
  for (const ref of created) await ref.update({ 'sent.created': true });
}

/* 3) 가입 신청 */
async function applicants(){
  const snap = await db.collection('members').where('notified', '==', false).get();
  if (snap.empty) return;
  const r = await roles();
  for (const d of snap.docs){
    const m = d.data();
    if (m.status === 'pending'){
      const c = await pushTo([r.owner, ...r.reviewers], '새 회원 가입 신청', `${m.name || ''}님 (${m.dong || ''}) — 승인 또는 불가를 선택해 주세요`, 'review', 'apply-' + d.id);
      log('가입 신청', m.name, c + '대');
    }
    await d.ref.update({ notified: true });
  }
}

/* 6) 가입 승인 알림 → 본인 */
async function welcomes(){
  const snap = await db.collection('members').where('welcomed', '==', false).get();
  for (const d of snap.docs){
    const m = d.data();
    if (m.status === 'approved'){
      const where = m.area ? ` · ${m.area}${m.lead ? ' 대표' : ''}로 배치되었습니다` : '';
      const c = await pushTo([d.id], '의왕의힘 회원이 되셨습니다', `${m.name || ''}님 환영합니다${where}. 눌러서 앱을 홈 화면에 설치해 주세요.`, 'roadmap', 'welcome-' + d.id);
      log('가입 승인 알림', m.name, c + '대');
    }
    await d.ref.update({ welcomed: true });
  }
}

/* 7) 추천 의견: 신청이 들어오면 추천인에게 요청, 추천인이 쓰면 최고 관리자·검토자에게 알림 */
async function referralsJob(){
  const r = await roles();
  const ask = await db.collection('referrals').where('notified', '==', false).get();
  for (const d of ask.docs){ const x = d.data();
    const c = await pushTo([x.ref], '추천 의견을 부탁드립니다', `${x.name || '신청자'}님이 회원님의 추천으로 가입을 신청했습니다. 눌러서 추천 사유와 활동 사진을 올려 주세요.`, 'review', 'ref-' + d.id);
    await d.ref.update({ notified: true }); log('추천 의견 요청', x.name, c + '대'); }
  const got = await db.collection('referrals').where('reasonNew', '==', true).get();
  for (const d of got.docs){ const x = d.data();
    const c = await pushTo([r.owner, ...r.reviewers], '추천 의견이 도착했습니다', `${x.refName || '추천인'}님이 ${x.name || '신청자'}님 추천 사유를 보냈습니다.`, 'review', 'refok-' + d.id);
    await d.ref.update({ reasonNew: false }); log('추천 의견 도착', x.name, c + '대'); }
}
/* 9) 비밀번호 찾기 요청 → 최고 관리자·공동 관리자·검토자에게 알림 */
async function pwHelpJob(){
  const snap = await db.collection('pwHelp').where('notified', '==', false).get(); if (snap.empty) return;
  const r = await roles();
  for (const d of snap.docs){ const x = d.data();
    const c = await pushTo([r.owner, ...r.admins, ...r.reviewers], '비밀번호 찾기 요청', `${x.name || '회원'}님(${x.loginId || ''})이 비밀번호를 잊었다고 요청했습니다. 눌러서 처리해 주세요.`, 'admin', 'pw-' + d.id);
    await d.ref.update({ notified: true }); log('비밀번호 찾기', x.name, c + '대'); }
}
/* 8) 첫 화면 숫자 다시 세기 (함께하는 시민) — count()는 1,000명당 읽기 1건이라 매번 함 */
async function statsJob(){
  const n = (await db.collection('supporters').count().get()).data().count;
  const st = await db.doc('stats/main').get();
  await db.doc('stats/main').set({ supporters: n, countedAt: new Date().toISOString() }, { merge: true });
  /* 리더 33인 모집 현황 (가입 링크가 리더/일반 신청서 중 무엇을 열지 정함)
     회원 전체를 5분마다 읽으면 무료 한도가 바닥나므로, 한국 날짜로 하루 1번 리더 후보만 읽음.
     평소에는 관리자 화면이 승인·배치할 때 public/stats를 바로 고침 */
  if (!needsRecount(st.exists ? st.data().countedDay : undefined, NOW)) return;
  const [byGrade, byArea] = await Promise.all([
    db.collection('members').where('grade', 'in', ['leader', 'chair', 'sec']).get(),
    db.collection('members').where('area', '!=', '').get(),
  ]);
  const docs = [...new Map([...byGrade.docs, ...byArea.docs].map(d => [d.id, { id: d.id, data: d.data() }])).values()];
  const { leaders, lr } = leaderStats(docs, await roles());
  await db.doc('public/stats').set({ leaders, lr, at: new Date().toISOString() });
  await db.doc('stats/main').set({ countedDay: kstDay(NOW) }, { merge: true });
  log('리더 숫자 다시 셈', leaders + '명');
}

/* 10) 옛 함께하는 시민 문서(문서 이름 = 전화번호) → 가린 번호 문서 + supKeys. 원본은 supportersOld에 백업.
   이미 같은 번호의 supKeys가 있으면(중복 등록) 새 문서를 만들지 않고 백업만. 옛 문서가 없으면 읽기 1건으로 끝남 */
async function supMigrateJob(){
  const snap = await db.collection('supporters').orderBy(admin.firestore.FieldPath.documentId()).startAt('01').endBefore('02').limit(300).get();
  let moved = 0, dup = 0;
  for (const d of snap.docs){
    const r = supSplit(d.id, d.data()); if (!r) continue;
    // 백업 이름에 시각을 붙여 같은 번호가 다시 옮겨져도 앞 백업을 덮어쓰지 않음.
    // 옛 문서는 읽은 뒤 바뀌지 않았을 때만 지움(그사이 회원이 지웠으면 이번 일괄 작업 전체가 취소됨)
    const backup = bt => { bt.set(db.doc('supportersOld/' + d.id + '_' + NOW), d.data()); bt.delete(d.ref, { lastUpdateTime: d.updateTime }); };
    const ref = db.collection('supporters').doc(), bt = db.batch();
    bt.set(ref, r.sup); bt.set(db.doc('supLinks/' + ref.id), r.link);
    bt.create(db.doc('supKeys/' + r.key), Object.assign({}, r.keyDoc, { sup: ref.id }));   // 이미 있으면(중복 등록) 실패
    backup(bt);
    try { await bt.commit(); moved++; }
    catch (e){
      if (e.code !== 6) throw e;   // 6 = ALREADY_EXISTS: 같은 번호가 이미 새 명단에 있음 → 새 문서 없이 백업만
      const b2 = db.batch(); backup(b2); await b2.commit(); dup++;
    }
  }
  if (moved || dup) log('시민 옮김', moved + '건', '(중복 ' + dup + '건)');
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
    // 관리자 계정(최고·공동 관리자·검토자)의 비밀번호는 최고 관리자만 초기화할 수 있음 (공동 관리자가 최고 관리자 계정을 가져가지 못하게)
    if (admins.has(q.uid) && q.by !== r.owner){ await d.ref.update({ done: true, error: '관리자 계정의 비밀번호는 최고 관리자만 초기화할 수 있습니다' }); log('비밀번호 초기화 거절(관리자 계정)', q.name); continue; }
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let temp = ''; for (let i = 0; i < 8; i++) temp += chars[crypto.randomInt(chars.length)];
    try { await admin.auth().updateUser(q.uid, { password: temp }); await d.ref.update({ done: true, temp, doneAt: new Date().toISOString() }); log('비밀번호 초기화', q.name); }
    catch (e){ await d.ref.update({ done: true, error: '회원 계정을 찾지 못했습니다' }); }
  }
}

(async () => {
  for (const [name, fn] of [['공지·일정', boardJob], ['유세', rallies], ['가입', applicants], ['페이스북', facebook], ['비밀번호', resets], ['승인 알림', welcomes], ['추천 의견', referralsJob], ['시민 옮기기', supMigrateJob], ['숫자 세기', statsJob], ['비밀번호 찾기', pwHelpJob]]){
    try { await fn(); } catch (e){ console.error(name + ' 처리 중 오류:', e.message); process.exitCode = 1; }
  }
})();
