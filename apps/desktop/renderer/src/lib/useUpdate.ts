// Состояние обновления приложения для компонентов (подписка на main через preload).
import { useEffect, useState } from 'react';
import type { UpdateState } from './updateModel';

export function useUpdate(): UpdateState | null {
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    const ipc = window.perimeterIPC;
    if (!ipc?.onUpdate) return;
    let live = true;
    void ipc.updateState?.().then((x) => { if (live) setS(x as UpdateState); }).catch(() => undefined);
    const off = ipc.onUpdate((x) => { if (live) setS(x as UpdateState); });
    return () => { live = false; off(); };
  }, []);
  return s;
}
