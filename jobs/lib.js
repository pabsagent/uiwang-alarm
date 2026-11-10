/* 알림 도우미가 쓰는 계산 함수 (Firebase 없이 시험할 수 있게 따로 둠) */
const GRADES = ['leader', 'normal', 'chair', 'sec'];

/* 한국 날짜 'YYYY-MM-DD' — GitHub는 UTC로 돌기 때문에 9시간을 더해 셈 */
const kstDay = nowMs => new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);

/* 오늘(한국 날짜) 아직 다시 세지 않았으면 true */
const needsRecount = (countedDay, nowMs) => countedDay !== kstDay(nowMs);

/* 등급: 정해진 4개 중 하나면 그대로, 아니면 예전 자료는 배치(area)가 있으면 리더 */
const gradeOf = d => (GRADES.includes(d.grade) ? d.grade : (d.area ? 'leader' : 'normal'));

/* 리더 수(리더 등급 승인 회원)와 리더 이상 목록(lr: 가입 링크가 리더 신청서를 열지 정함) */
function leaderStats(docs, roles){
  const ok = docs.filter(x => x.data.status === 'approved');
  const leaders = ok.filter(x => gradeOf(x.data) === 'leader').length;
  const lr = [...new Set(ok.filter(x => gradeOf(x.data) !== 'normal').map(x => x.id)
    .concat(roles.owner ? [roles.owner] : [], roles.admins || [], roles.reviewers || []))].sort();
  return { leaders, lr };
}

/* 알림 본문의 날짜: '11.20(금) 오후 7:00 · 장소' (한국 시간) */
const WD = ['일','월','화','수','목','금','토'];
function whenText(n, atMs){
  const at = new Date(atMs + 9 * 3600000);
  const h = at.getUTCHours(), m = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCMonth() + 1}.${at.getUTCDate()}(${WD[at.getUTCDay()]}) ${h < 12 ? '오전' : '오후'} ${(h % 12) || 12}:${m}` + (n.place ? ` · ${n.place}` : '');
}

/* 같은 때 보낼 알림 여러 개를 휴대폰 알림 1개로 묶음.
   items = [{title, sub, at}] — 가장 가까운(at이 가장 작은) 일정을 제목에, 나머지는 ‘외 N건’과 본문 목록(최대 5개)으로 */
function bundlePush(label, items){
  if (!items.length) return null;
  const s = items.slice().sort((a, b) => a.at - b.at), first = s[0], rest = s.slice(1);
  if (!rest.length) return { title: `[${label}] ${first.title}`, body: first.sub };
  const names = rest.slice(0, 5).map(x => x.title).join(', ') + (rest.length > 5 ? ` 외 ${rest.length - 5}건` : '');
  return { title: `[${label} ${s.length}건] ${first.title} 외 ${rest.length}건`, body: `${first.sub}\n그 밖에: ${names}` };
}

/* 공지·일정 글의 미리 알림 단계: 하루 전 09:00(d1) · 당일 09:00(d0) · 1시간 전(h1, 시간이 있을 때만).
   send = 지금 보낼 단계(밀린 것이 여럿이면 가장 늦은 것 하나), mark = 보냈다고 표시할 단계(등록 전에 이미 지난 단계 포함) */
function dueStage(p, now){
  const none = { send: null, mark: [] };
  if (!p.notify || !p.atMs || !p.date || now >= p.atMs) return none;
  const nine = Date.parse(p.date + 'T09:00:00+09:00'), created = Date.parse(p.createdAt || '') || 0, sent = p.sent || {};
  const st = [{ k: 'd1', t: nine - 86400000 }, { k: 'd0', t: nine }].concat(p.time ? [{ k: 'h1', t: p.atMs - 3600000 }] : [])
    .filter(s => s.t < p.atMs && !sent[s.k] && s.t <= now);
  const skip = st.filter(s => s.t < created), due = st.filter(s => s.t >= created).sort((a, b) => a.t - b.t);
  return { send: due.length ? due[due.length - 1].k : null, mark: skip.concat(due).map(s => s.k) };
}

/* 옛 함께하는 시민 문서(문서 이름 = 전화번호, 전체 번호가 그대로 있음) → 가린 번호 문서 + supKeys 문서.
   화면의 supRecord(public/lib/text.js)와 같은 모양. 이미 새 모양이거나 이름이 전화번호가 아니면 null */
const PHONE_ID = /^01[016789]\d{7,8}$/;
function maskPhone(p){
  const d = String(p || '').replace(/\D/g, ''); if (!PHONE_ID.test(d)) return '';
  return d.slice(0, 3) + '-' + '*'.repeat(d.length - 7) + '-' + d.slice(-4);
}
function supSplit(id, d){
  if (!PHONE_ID.test(id) || d.phoneMasked) return null;
  const phone = d.phone || id;
  const sup = { name: d.name || '', phoneMasked: maskPhone(phone), dong: d.dong || '', gender: d.gender || '', ageBand: d.ageBand || '',
    by: d.by || '', byName: d.byName || '', createdAt: d.createdAt || '' };
  const link = { key: id, by: d.by || '' }, keyDoc = { by: d.by || '', phone };
  if (d.via){ sup.via = d.via; link.via = d.via; keyDoc.via = d.via; }
  return { key: id, sup, link, keyDoc };
}

/* ===== 7A: FCM 주제 'all' (회원 전체 알림을 한 번에) =====
   주제에 넣을 사람: 승인 회원 + 관리자(최고·공동·검토자). 삭제·불가는 뺌. 그 밖(가입 대기 등)은 승인될 때까지 기다림 */
function topicTarget(member, uid, roles){
  const r = roles || {};
  if (uid && (r.owner === uid || (r.admins || []).includes(uid) || (r.reviewers || []).includes(uid))) return 'in';
  const st = member && member.status;
  if (st === 'approved') return 'in';
  if (st === 'deleted' || st === 'rejected') return 'out';
  return 'wait';
}
/* 알림 모양 (pushTo와 같음, 받는 대상만 빼고) */
function pushPayload(title, body, view, tag){
  return {
    notification: { title, body },
    data: { view: view || 'notices', tag: tag || '' },
    webpush: { fcmOptions: { link: '/#' + (view || 'notices') }, notification: { icon: '/icons/icon-192.png', tag: tag || undefined } },
  };
}

/* 7C: 단체별 이름 목록 — public/lib/text.js groupIdx와 같은 규칙 (한쪽을 바꾸면 다른 쪽도) */
const GROUP_IDX_MAX = 15000;
function groupIdx(members, group){
  const all = (members || []).filter(m => m.status === 'approved' && (m.groups || []).includes(group))
    .map(m => ({ id: m.id, name: m.name || '' })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { members: all.slice(0, GROUP_IDX_MAX), more: all.length > GROUP_IDX_MAX };
}

module.exports = { groupIdx, topicTarget, pushPayload, kstDay, needsRecount, gradeOf, leaderStats, whenText, bundlePush, dueStage, supSplit };
