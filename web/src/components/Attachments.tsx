import type { Attachment } from '../../../server/src/shared/protocol';
import { cx, Icon } from './ui';

export const isImage = (mime: string) => /^image\/(png|jpeg|gif|webp)$/.test(mime);

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Attachments shown inside a sent message: image thumbnails and file chips. `urlOf`: an attachment's address. */
export function MessageAttachments({ items, urlOf }: { items: Attachment[]; urlOf: (id: string) => string }) {
  const images = items.filter((a) => isImage(a.mime));
  const files = items.filter((a) => !isImage(a.mime));
  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((a) => (
            <a key={a.id} href={urlOf(a.id)} target="_blank" rel="noreferrer" title={a.name}>
              <img
                src={urlOf(a.id)}
                alt={a.name}
                loading="lazy"
                className="h-24 max-w-[200px] rounded-lg border border-zinc-700 object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a
          key={a.id}
          href={urlOf(a.id)}
          className="ml-auto flex w-fit max-w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs hover:border-zinc-500"
        >
          <Icon name="folder" className="text-zinc-400" />
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 text-zinc-500">{fmtSize(a.size)}</span>
        </a>
      ))}
    </div>
  );
}

export interface PendingFile {
  key: string;
  file: File;
  preview?: string;
  progress: number;
  attachment?: Attachment;
  error?: string;
}

/** Files waiting in the composer: upload progress, errors and a remove button. */
export function ComposerAttachments({ items, onRemove }: { items: PendingFile[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {items.map((p) => (
        <div
          key={p.key}
          className={cx(
            'relative flex h-14 shrink-0 items-center gap-2 rounded-lg border bg-zinc-900 pr-7 text-xs',
            p.error ? 'border-red-500/50' : 'border-zinc-700',
            p.preview ? 'pl-0' : 'pl-2.5',
          )}
          title={p.error ?? p.file.name}
        >
          {p.preview ? (
            <img src={p.preview} alt="" className="h-full w-14 rounded-l-lg object-cover" />
          ) : (
            <Icon name="folder" className="text-zinc-400" />
          )}
          <div className="max-w-[9rem]">
            <div className="truncate">{p.file.name || '粘贴的图片'}</div>
            <div className={cx('text-[11px]', p.error ? 'text-red-400' : 'text-zinc-500')}>
              {p.error ?? (p.attachment ? fmtSize(p.file.size) : `上传中 ${Math.round(p.progress * 100)}%`)}
            </div>
          </div>
          <button
            onClick={() => onRemove(p.key)}
            className="absolute right-1 top-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="移除附件"
          >
            <Icon name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
