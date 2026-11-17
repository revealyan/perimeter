// Установщик supervisor'а из терминала — то же, что кнопки «Supervisor на сервере» в настройках подключения (АДР 004).
// Подключения — из ~/.perimeter-client/connections.json приложения.
//   node scripts/server-install.mjs                         — список подключений
//   node scripts/server-install.mjs <id|имя> status         — что стоит на сервере
//   node scripts/server-install.mjs <id|имя> install [пользователь службы]
//   node scripts/server-install.mjs <id|имя> rollback
//   node scripts/server-install.mjs <id|имя> packages [пакет…] — доустановить системные (без списка — все недостающие)
// PERIMETER_SERVER_BUNDLE=<папка> — готовая сборка вместо сборки из исходников.
import { clientDir, loadConnections } from '../apps/desktop/main/connections.mjs';
import { ServerInstaller } from '../apps/desktop/main/server-install.mjs';

const [who, cmd = 'status', arg] = process.argv.slice(2);
const { list } = loadConnections(clientDir());
if (!who) {
  for (const c of list) console.log(`${c.id}\t${c.name}\t${c.user}@${c.host}:${c.port} → ${c.remotePort}${c.serviceUser ? `\tслужба: ${c.serviceUser}` : ''}`);
  process.exit(0);
}
const conn = list.find((c) => c.id === who || c.name === who);
if (!conn) {
  console.error(`подключения «${who}» нет`);
  process.exit(2);
}
const inst = new ServerInstaller();
const log = (l) => console.log(`  ${l}`);
let r;
if (cmd === 'status') r = await inst.status(conn);
else if (cmd === 'install') r = await inst.install(arg ? { ...conn, serviceUser: arg } : conn, log);
else if (cmd === 'rollback') r = await inst.rollback(conn, log);
else if (cmd === 'packages') {
  let rest = process.argv.slice(4).filter((x) => !x.startsWith('-'));
  if (rest.length === 0) {
    // без списка — все недостающие из статуса
    const st = await inst.status(conn);
    if (!st.ok) { console.error(st.message); process.exit(1); }
    rest = st.packagesMissing ?? [];
    if (rest.length === 0) { console.log('  всё на месте — недостающих пакетов нет'); }
  }
  r = rest.length > 0 ? await inst.packages(conn, rest, log) : { ok: true, message: 'недостающих пакетов нет' };
}
else {
  console.error(`неизвестная команда «${cmd}» (status | install | rollback | packages)`);
  process.exit(2);
}
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
