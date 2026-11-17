// Блок «Supervisor на сервере»: подписи и кнопки по статусу установщика (АДР 004).
import { describe, expect, it } from 'vitest';
import { BUSY_WARNING, describeServer, packagesLine, type ServerStatus } from './serverInstallModel';

const base: ServerStatus = {
  ok: true, appVersion: '0.1.0-cccccccc', mode: 'system', sshUser: 'root', serviceUser: 'yan', systemd: true,
  unit: true, managed: true, active: 'active', current: '0.1.0-cccccccc', previous: '0.1.0-bbbbbbbb', running: '0.1.0-cccccccc', busy: 0,
};

describe('describeServer', () => {
  it('та же версия и отвечает — «актуально», без главной кнопки, откат есть', () => {
    const v = describeServer({ ...base, plan: 'ok' });
    expect(v.tone).toBe('ok');
    expect(v.primary).toBeUndefined();
    expect(v.rollback).toBe('Откатить на 0.1.0-bbbbbbbb');
  });

  it('другая версия — «Обновить до <версия приложения>»; отвечает не та — видно', () => {
    const v = describeServer({ ...base, plan: 'update', current: '0.1.0-aaaaaaaa', running: '0.1.0-bbbbbbbb' });
    expect(v.primary).toBe('Обновить до 0.1.0-cccccccc');
    expect(v.text).toContain('отвечает 0.1.0-bbbbbbbb');
  });

  it('служба из исходников — «Установить», пояснение про прежний юнит, отката нет', () => {
    const v = describeServer({ ...base, plan: 'install', managed: false, current: '', previous: '', running: '0.1.0' });
    expect(v.primary).toBe('Установить 0.1.0-cccccccc');
    expect(v.notes[0]).toContain('.before-installer');
    expect(v.rollback).toBeUndefined();
    expect(v.askUser).toBe(true);
  });

  it('ничего нет — «не установлен»; вход не под root — имя не спрашиваем', () => {
    const v = describeServer({ ...base, plan: 'install', mode: 'user', unit: false, managed: false, current: '', previous: '' });
    expect(v.text).toBe('Supervisor на сервере не установлен.');
    expect(v.askUser).toBe(false);
  });

  it('идут ходы — предупреждение; linger выключен у службы пользователя — подсказка', () => {
    expect(describeServer({ ...base, plan: 'update', current: 'x', busy: 2 }).notes).toContain(BUSY_WARNING(2));
    expect(BUSY_WARNING(1)).toContain('1 сессии');
    const v = describeServer({ ...base, plan: 'ok', mode: 'user', sshUser: 'dev', serviceUser: 'dev', linger: 'no' });
    expect(v.notes.join(' ')).toContain('loginctl enable-linger dev');
  });

  it('та же версия молчит — «Переустановить»; нет systemd или ssh — ошибка без кнопок', () => {
    expect(describeServer({ ...base, plan: 'restart', running: '', active: 'failed' })).toMatchObject({ tone: 'warn', primary: 'Переустановить' });
    const noSystemd = describeServer({ ...base, systemd: false });
    expect(noSystemd.tone).toBe('err');
    expect(noSystemd.primary).toBeUndefined();
    expect(describeServer({ ok: false, message: 'ключ не подошёл' })).toMatchObject({ tone: 'err', text: 'ключ не подошёл' });
  });

  it('packagesLine: недостающие с пояснением; не-apt — команда для рук; всё есть — null', () => {
    expect(packagesLine({ ...base })).toBeNull();
    expect(packagesLine({ ...base, packagesMissing: ['git', 'xvfb'] })).toContain('git (панель «Файлы»');
    expect(packagesLine({ ...base, packagesMissing: ['git'], pkgManager: 'none' })).toContain('поставьте руками');
  });
});
