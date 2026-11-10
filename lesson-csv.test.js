const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const inline = fs.readFileSync('index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const start = inline.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  const rest = inline.slice(start), end = rest.slice(1).search(/\n  (?:async )?function /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}
const row = (id = 'new-lesson', title = '架空の学び') => [id, 'Day9', title, '要点', '問い', '実践', '架空の出典', 'https://example.test/lesson'];
const lesson = id => ({id, day:'Day8', title:'以前の学び', summary:'既存の要点', question:'以前の問い', action:'以前の実践', source:'架空の出典', url:''});
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(count = 14) {
  const c = {KEY:'fixture', storageError:false, localSaveEvidence:'loaded', toasts:[], renders:0, writes:0, fail:false,
    data:null, fieldNames:[], GoalProgress:{empty:()=>({}), normalize:p=>p || {}}, document:{querySelectorAll:()=>[]},
    updateAutoSyncNotice:()=>{}};
  c.showToast = text => c.toasts.push(text);
  c.render = () => c.renders++;
  c.localStorage = {setItem(_key, value) {c.writes++; if(c.fail) throw Error('synthetic quota'); c.stored = value;}};
  vm.createContext(c);
  for(const name of ['DEFAULT_LESSONS', 'LESSON_HEADERS', 'initial']) {
    vm.runInContext(inline.match(new RegExp('  const ' + name + '=.*?;\\n'))[0], c);
  }
  for(const name of ['txt', 'cleanString', 'normalize', 'save', 'mergeLessonRows', 'parseCsv']) vm.runInContext(source(name), c);
  c.headers = plain(vm.runInContext('LESSON_HEADERS', c));
  c.data = vm.runInContext('initial()', c);
  while(c.data.lessons.length < count) c.data.lessons.push(lesson('old-' + c.data.lessons.length));
  c.data.entries = {'2026-11-10':{lessonId:c.data.lessons[0].id, lessonNotes:{retained:{reflection:'端末だけの既存メモ'}}}};
  c.stored = JSON.stringify(c.data);
  c.import = rows => c.mergeLessonRows([c.headers, ...rows], 'CSV');
  return c;
}
function unchanged(c, before, previous) {
  assert.equal(JSON.stringify(c.data), before);
  assert.equal(c.stored, before);
  assert.equal(c.data.lessons, previous);
  assert.equal(c.renders, 0);
  assert.ok(c.toasts.every(message => !message.includes('追加しました')));
}
test('800 existing lessons reject a new record without changing memory or persistence', () => {
  const c = fixture(800), before = c.stored, previous = c.data.lessons;
  assert.throws(() => c.import([row()]), /最大800件.*登録済み800件・新規1件/);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
});
test('a batch crossing 800 is rejected in full rather than partially added', () => {
  const c = fixture(799), before = c.stored, previous = c.data.lessons;
  assert.throws(() => c.import([row('new-1'), row('new-2')]), /今回は追加していません/);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
});
test('799 plus one persists exactly 800 and survives normal reload unchanged', () => {
  const c = fixture(799), oldLessons = plain(c.data.lessons), oldNotes = plain(c.data.entries);
  assert.equal(c.import([row()]), 1);
  const stored = JSON.parse(c.stored), loaded = c.normalize(stored);
  assert.equal(stored.lessons.length, 800); assert.equal(loaded.lessons.length, 800);
  assert.deepEqual(stored.lessons.slice(0, 799), oldLessons);
  assert.deepEqual(plain(loaded.lessons), stored.lessons);
  assert.deepEqual(stored.entries, oldNotes);
  assert.match(c.toasts.at(-1), /^1件の新しい学びをCSVから追加しました/);
  assert.equal(c.writes, 1); assert.equal(c.renders, 1);
});
test('repeated storage failures roll back all additions; same CSV can retry once capacity returns', () => {
  const c = fixture(), before = c.stored, previous = c.data.lessons;
  c.fail = true;
  for(let i = 0; i < 2; i++) {
    assert.throws(() => c.import([row()]), /端末に保存できなかった.*同じCSV/);
    unchanged(c, before, previous); assert.equal(c.storageError, true);
    assert.match(c.toasts.at(-1), /保存できません/);
  }
  c.fail = false;
  assert.equal(c.import([row()]), 1); assert.equal(c.data.lessons.length, 15);
  assert.equal(JSON.parse(c.stored).lessons.filter(l => l.id === 'new-lesson').length, 1);
  assert.equal(c.storageError, false); assert.equal(c.localSaveEvidence, 'saved');
  assert.equal(c.renders, 1); assert.match(c.toasts.at(-1), /^1件/);
});
test('duplicate-only CSV at the limit neither writes nor pretends that records were added', () => {
  const c = fixture(800), before = c.stored, previous = c.data.lessons;
  assert.equal(c.import([row(previous[0].id, '上書きしない')]), 0);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
  assert.match(c.toasts.at(-1), /新しく追加できる学びはありません/);
});
test('existing IDs and repeated incoming IDs are retained, counted once, and do not consume extra capacity', () => {
  const c = fixture(799), before = plain(c.data.lessons);
  assert.equal(c.import([row(before[0].id, '上書きしない'), row(), row('new-lesson', '後続は無視')]), 1);
  assert.deepEqual(plain(c.data.lessons.slice(0, 799)), before);
  assert.equal(c.data.lessons.at(-1).title, '架空の学び');
});
test('existing duplicate records are not silently collapsed by import', () => {
  const c = fixture(); c.data.lessons.push({...c.data.lessons[0], title:'保持する既存の別内容'});
  const before = plain(c.data.lessons);
  assert.equal(c.import([row()]), 1);
  assert.deepEqual(plain(c.data.lessons.slice(0, before.length)), before);
});
test('more than 1,500 data rows reject the whole CSV, including a new record in its final row', () => {
  const c = fixture(), before = c.stored, previous = c.data.lessons;
  const rows = Array.from({length:1500}, () => row(previous[0].id)); rows.push(row());
  assert.throws(() => c.import(rows), /最大1,500行/);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
});
test('exactly 1,500 rows are all examined', () => {
  const c = fixture(); const rows = Array.from({length:1499}, () => row(c.data.lessons[0].id)); rows.push(row());
  assert.equal(c.import(rows), 1); assert.equal(c.data.lessons.at(-1).id, 'new-lesson');
});
for(const [name, alter, message] of [
  ['100-character ID', r => r[0] = 'x'.repeat(100), /IDは99文字/],
  ['overlong body', r => r[3] = 'あ'.repeat(4001), /各項目4,000文字/],
  ['overlong URL', r => r[7] = 'https://' + 'x'.repeat(693), /700文字/],
  ['unsupported URL', r => r[7] = 'http://example.test/', /https:\/\//]
]) test(name + ' rejects all pending additions instead of losing imported fields on reload', () => {
  const c = fixture(), before = c.stored, previous = c.data.lessons, invalid = row('invalid'); alter(invalid);
  assert.throws(() => c.import([row(), invalid]), message);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
});
test('maximum supported field lengths persist without truncation', () => {
  const c = fixture(), r = row('x'.repeat(99)); r[3] = 'あ'.repeat(4000); r[7] = 'https://' + 'x'.repeat(692);
  assert.equal(c.import([r]), 1);
  assert.deepEqual(plain(c.normalize(JSON.parse(c.stored)).lessons), JSON.parse(c.stored).lessons);
});
test('bad headers and malformed CSV leave existing records unchanged', () => {
  const c = fixture(), before = c.stored, previous = c.data.lessons;
  assert.throws(() => c.mergeLessonRows([['wrong'], row()], 'CSV'), /見出しが違います/);
  assert.throws(() => c.parseCsv('ID,講義\n"unclosed'), /引用符/);
  unchanged(c, before, previous); assert.equal(c.writes, 0);
});
test('CSV with BOM, CRLF, quoted comma and newline imports fully', () => {
  const c = fixture(); const text = '\uFEFF' + c.headers.join(',') + '\r\nnew-quoted,Day9,"テーマ, 続き","要点\n改行",問い,実践,出典,\r\n';
  assert.equal(c.mergeLessonRows(c.parseCsv(text), 'CSV'), 1);
  assert.equal(JSON.parse(c.stored).lessons.at(-1).title, 'テーマ, 続き');
  assert.equal(JSON.parse(c.stored).lessons.at(-1).summary, '要点\n改行');
});
test('the actual file input handler reports failure, allows reselection, then reports persisted success', () => {
  const c = fixture(), before = c.stored, handlers = {};
  c.progressCtx = () => ({}); c.GoalProgress.change = () => false;
  c.document.addEventListener = (type, handler) => handlers[type] = handler;
  c.FileReader = class {readAsText(file) {this.result = file.text; if(file.failure) this[file.failure](); else this.onload();}};
  vm.runInContext(inline.split('\n').find(line => line.startsWith("  document.addEventListener('change',") && line.endsWith("});")), c);
  const file = {size:100, text:[c.headers,row()].map(r => r.join(',')).join('\n')};
  const input = {id:'lessonCsvFile', value:'fixture.csv', files:[file], matches:()=>false};
  c.fail = true; handlers.change({target:input});
  assert.equal(input.value,''); assert.equal(c.stored,before);
  assert.match(c.toasts.at(-1), /学びの読み込み失敗：端末に保存できなかった/);
  assert.ok(c.toasts.every(message => !message.includes('追加しました')));
  c.fail = false;
  for(const failure of ['onerror','onabort']) {
    file.failure = failure; handlers.change({target:input});
    assert.equal(c.stored,before); assert.match(c.toasts.at(-1),/追加はしていません/);
  }
  delete file.failure; handlers.change({target:input});
  assert.match(c.toasts.at(-1), /^1件の新しい学びをCSVから追加しました/);
  assert.equal(JSON.parse(c.stored).lessons.at(-1).id,'new-lesson');
});
