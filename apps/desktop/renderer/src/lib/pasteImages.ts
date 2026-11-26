// Картинки во вложения сообщения: пустые не берём. 26.11 вставка скриншота дала файл 0 байт (Windows отдаёт
// отложенный файл), он ушёл агенту — Claude Code ответил «Image file is empty (0 bytes)», в ленте — битое вложение.

/** Картинки с содержимым (пустые файлы — отдельно: им нужен запасной путь через буфер ОС). */
export function splitImageFiles(files: ArrayLike<{ type: string; size: number }>): { ok: number[]; empty: number } {
  const ok: number[] = [];
  let empty = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 0) ok.push(i);
    else empty++;
  }
  return { ok, empty };
}

/** data URL с данными (FileReader у пустого файла даёт «data:image/png;base64,» — такой не прикрепляем). */
export const hasImageData = (dataUrl: string): boolean => /^data:image\/[a-z0-9.+-]+;base64,.+/is.test(dataUrl);
