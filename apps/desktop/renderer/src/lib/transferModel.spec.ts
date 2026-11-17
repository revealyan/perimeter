// План переноса сессии между средами (T-ряд): проект по имени, аккаунт цели, база патча правок.
import { describe, expect, it } from 'vitest';
import { planTransfer, type TransferInput } from './transferModel';

const base: TransferInput = {
  session: { name: 'редизайн', state: 'idle', profile: 'yan', model: 'glm-5.3[1m]', permissionMode: 'auto', effort: 'high', ultracode: false, projectId: 'p1' },
  srcProject: { name: 'perimeter' },
  dstProjects: [{ name: 'конвейер' }],
  dstProfiles: [{ name: 'yan' }, { name: 'zai' }],
  srcHead: 'abc123',
  dstHead: 'abc123',
};

describe('planTransfer', () => {
  it('проект есть на цели по имени, коммиты совпали — патч разрешён', () => {
    const p = planTransfer({ ...base, dstProjects: [{ name: 'perimeter' }, { name: 'конвейер' }] });
    expect(p.projectName).toBe('perimeter');
    expect(p.createProject).toBeNull();
    expect(p.profileKnown).toBe(true);
    expect(p.base).toBe('same');
    expect(p.patchAllowed).toBe(true);
  });

  it('проекта на цели нет — создадим папку по слагу названия', () => {
    const p = planTransfer(base);
    expect(p.createProject).toBe('perimeter');
  });

  it('название кириллицей → слаг латиницей (как диалог нового проекта)', () => {
    const p = planTransfer({ ...base, srcProject: { name: 'лендинг студии' } });
    expect(p.createProject).toBe('lending-studii');
  });

  it('ветки разошлись — патч запрещён, история едет (решение владельца: только предупредить)', () => {
    const p = planTransfer({ ...base, dstProjects: [{ name: 'perimeter' }], dstHead: 'def999' });
    expect(p.base).toBe('diverged');
    expect(p.patchAllowed).toBe(false);
  });

  it('не git с любой стороны — патч невозможен', () => {
    expect(planTransfer({ ...base, dstProjects: [{ name: 'perimeter' }], srcHead: null }).base).toBe('nogit');
    expect(planTransfer({ ...base, dstProjects: [{ name: 'perimeter' }], dstHead: null }).patchAllowed).toBe(false);
  });

  it('аккаунта сессии нет на цели — предлагаем перенос с аккаунтом цели', () => {
    const p = planTransfer({ ...base, dstProjects: [{ name: 'perimeter' }], dstProfiles: [{ name: 'zai' }] });
    expect(p.profileKnown).toBe(false);
  });

  it("сессия без профиля (аккаунт supervisor'а) — на любой цели известен", () => {
    const p = planTransfer({ ...base, session: { ...base.session, profile: undefined }, dstProjects: [{ name: 'perimeter' }] });
    expect(p.profileKnown).toBe(true);
  });

  it('сессия без проекта — проект не едёт, папку не создаём', () => {
    const p = planTransfer({ ...base, srcProject: undefined, session: { ...base.session, projectId: undefined } });
    expect(p.projectName).toBeUndefined();
    expect(p.createProject).toBeNull();
  });
});
