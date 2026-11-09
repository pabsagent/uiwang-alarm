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

module.exports = { kstDay, needsRecount, gradeOf, leaderStats };
